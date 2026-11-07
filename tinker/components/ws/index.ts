import { capsule, data, operation, tag } from "@tinker/core";

import { callInput, kept, openInput, protocol, sendInput, watchInput } from "~/components/protocol";
import type {
  Call,
  ClientSide,
  Codec,
  MetaOp,
  Protocol,
  RenewOp,
  Reply,
  Watch,
} from "~/components/protocol";

// The WebSocket transport, client side: every call and watch of a client on ONE socket.
// As tRPC wsLink: messages carry an id; as httpBatchLink: the messages of one tick go as one
// frame (a JSON array, at most 32). Both ways: the server also sends one frame per tick, so the
// keys one write changed arrive together (F35) with no shared stream in the protocol.
//
//   call   {i, a: address, t: text, m: meta}     answer {i, t} | {i, e: status}
//   watch  {i, a, t, m, w: 1}                    pushes {i, t} ... then {i, end: 1}
//   stop   {i, x: 1}
//
// The socket opens on the first message (wsLink lazy) and closes with the scope. When it drops,
// every call and watch on it fails as a link fault; remoteData's back-off opens a new one.

type ClientConfig = {
  url: string;
  /** Headers on the upgrade (Bun only: a browser sends its own cookies; a test sets them). */
  headers?: Readonly<Record<string, string>>;
  codec?: Codec;
  meta?: MetaOp;
  renew?: RenewOp;
};

/** One message of a frame, client to server. */
type Out = { i: number; a?: string; t?: string; m?: Record<string, string>; w?: 1; x?: 1 };
/** One message of a frame, server to client. */
type In = { i: number; t?: string; e?: number; end?: 1 };
/** Gets each message for its id; null when the socket dropped. */
type Waiter = (message: In | null) => void;

/** The most messages in one frame: the server closes a socket that sends more (tRPC maxBatchSize). */
export const frameMax = 32;

/** Makes one WebSocket client. */
export function createWs() {
  const url = tag<string>({ label: "ws.url" });
  const headers = tag<Readonly<Record<string, string>>>({ label: "ws.headers", default: {} });
  const keys = {
    codec: tag<Codec>({ label: "ws.codec" }).optional,
    meta: tag<MetaOp>({ label: "ws.meta" }).optional,
    renew: tag<RenewOp>({ label: "ws.renew" }).optional,
  };

  /** The open sockets (one at most), the waiters by id, the next id, `post`. One per scope. */
  type Link = {
    sockets: Set<WebSocket>;
    waits: Map<number, Waiter>;
    next: number;
    post: (message: Out) => void;
  };
  const link = data<Link | null>({ label: "ws.link", initial: null });

  // Text, one layer down: the protocol calls these. The span goes as `traceparent` in `m`.
  const send = operation({
    label: "ws.send",
    input: sendInput,
    depends: { link: link.controller, protocol },
    run: ({ link, protocol }, { input, signal, obs }) => {
      const own = link.get()!;
      const i = own.next++;
      const m = { ...input.meta, ...protocol.traceparent(obs.span) };
      return new Promise<string>((got, fail) => {
        own.waits.set(i, (message) => {
          own.waits.delete(i);
          if (message?.t !== undefined) got(message.t);
          else fail(Object.assign(new Error("TransportFailed"), { payload: message }));
        });
        signal.addEventListener("abort", () => {
          if (own.waits.delete(i)) own.post({ i, x: 1 });
          fail(signal.reason);
        });
        own.post({ i, a: input.address, t: input.text, m });
      });
    },
  });

  const open = operation({
    label: "ws.open",
    input: openInput,
    depends: { link: link.controller, protocol },
    run: ({ link, protocol }, { input, signal, obs }) => {
      const own = link.get()!;
      const i = own.next++;
      const m = { ...input.meta, ...protocol.traceparent(obs.span) };
      return new Promise<void>((ended, fail) => {
        own.waits.set(i, (message) => {
          if (message?.t !== undefined) return input.push(message.t);
          own.waits.delete(i);
          if (message?.end) ended();
          else fail(Object.assign(new Error("TransportFailed"), { payload: message }));
        });
        // A reader that leaves stops the server's stream: the server ends the watch.
        signal.addEventListener("abort", () => {
          if (own.waits.delete(i)) own.post({ i, x: 1 });
          ended();
        });
        own.post({ i, a: input.address, t: input.text, m, w: 1 });
      });
    },
  });

  /** What rpc and remoteData run: a value out, the reply (or the pushes) back. */
  const call = operation({
    label: "ws.call",
    input: callInput,
    run: (): Promise<Reply> => {
      throw new Error("ws: no transport here");
    },
  }) as Call;

  const watch = operation({
    label: "ws.watch",
    input: watchInput,
    run: (): Promise<void> => {
      throw new Error("ws: no transport here");
    },
  }) as Watch;

  const held = data<{ side: ClientSide; protocol: Protocol } | null>({
    label: "transport.client",
    initial: null,
  });

  /** The client: `call` and `watch`, for rpc and remoteData. */
  const client = capsule({
    label: "ws",
    config: { url: url.required, headers, ...keys },
    exports: { call, watch },
    hooks: {
      async start({ config, load, next }) {
        const p = await load(protocol, kept);

        const out: Out[] = [];
        const waits = new Map<number, Waiter>();
        const sockets = new Set<WebSocket>();
        let opening: Promise<WebSocket> | null = null;

        // The first message of a tick schedules the frame; the frame opens the socket if needed.
        const post = (message: Out) => {
          if (out.push(message) > 1) return;
          setTimeout(() => {
            const sent = out.splice(0);
            opening ??= new Promise<WebSocket>((done, broke) => {
              const socket = Object.keys(config.headers).length
                ? new WebSocket(config.url, { headers: config.headers } as never)
                : new WebSocket(config.url);
              socket.addEventListener("open", () => done((sockets.add(socket), socket)));
              socket.addEventListener("message", (event) => {
                for (const m of JSON.parse(String(event.data)) as In[]) waits.get(m.i)?.(m);
              });
              socket.addEventListener("close", () => {
                sockets.delete(socket);
                opening = null;
                for (const waiter of waits.values()) waiter(null);
                waits.clear();
                broke(new Error("TransportFailed"));
              });
            });
            void opening.then(
              (socket) => {
                for (let at = 0; at < sent.length; at += frameMax) {
                  socket.send(JSON.stringify(sent.slice(at, at + frameMax)));
                }
              },
              () => undefined, // the close already failed every waiter
            );
          }, 0);
        };

        load(link, kept).set({ sockets, waits, next: 1, post });
        load(held, kept).set({
          protocol: p,
          side: {
            send,
            open,
            codec: p.given(config.codec) ?? p.json,
            meta: p.given(config.meta),
            renew: p.given(config.renew),
          },
        });

        return next();
      },
      run({ op, call: invocation, run, log, load, next }): unknown {
        if (op !== call && op !== watch) return next();
        const { side, protocol: p } = load(held, kept).get()!;
        const hook = { run, log, signal: invocation?.signal };
        const input = (invocation?.input ?? invocation?.rawInput) as never;
        return op === call ? p.callOver(side, hook, input) : p.watchOver(side, hook, input);
      },
      async close({ load, next }) {
        for (const socket of load(link, kept).get()?.sockets ?? []) socket.close(1000);
        return next();
      },
    },
  });

  return {
    client: client as unknown as Omit<typeof client, never> & {
      readonly call: Call;
      readonly watch: Watch;
      (values: ClientConfig): ReturnType<typeof client>;
    },
  };
}

/** The default WebSocket client. */
export const ws = createWs();
