import { capsule, data, operation, tag } from "@tinker/core";
import type { Scope } from "@tinker/core";

import { callInput, kept, openInput, protocol, sendInput, watchInput } from "~/components/protocol";
import type {
  Call,
  ClientSide,
  Codec,
  MetaOp,
  Protocol,
  Pushes,
  RenewOp,
  Reply,
  ServerSide,
  Service,
  Streams,
  TextServe,
  TextStream,
  Watch,
} from "~/components/protocol";
import { requestStop } from "~/components/requests";
import { routes, traceparent } from "~/components/requests/index.server";

// The memory transport (tests): the same protocol, in one process. The client runs the server
// scope's text ops in one session per request, as sse.server does: in the client's trace, with
// a request bound (`routes.request`, the fixed headers). A peer holds one memory server.

type ClientConfig = {
  peer: Scope.Handle;
  headers?: Readonly<Record<string, string>>;
  codec?: Codec;
  pushes?: Pushes;
  streams?: Streams;
  meta?: MetaOp;
  renew?: RenewOp;
};

/** The server's text ops: one pair for every memory transport, so any memory client reaches it. */
const serve = operation({
  label: "memory.serve",
  input: sendInput,
  run: (): Promise<string | null> => {
    throw new Error("memory: no server here");
  },
}) as TextServe;

const serveStream = operation({
  label: "memory.serveStream",
  input: openInput,
  run: (): Promise<boolean> => {
    throw new Error("memory: no server here");
  },
}) as TextStream;

/** Makes one memory transport. A scope can hold two clients (a public one and a signed one). */
export function createMemory() {
  const peer = tag<Scope.Handle>({ label: "memory.peer" });
  const headers = tag<Readonly<Record<string, string>>>({ label: "memory.headers", default: {} });
  const keys = {
    codec: tag<Codec>({ label: "memory.codec" }).optional,
    pushes: tag<Pushes>({ label: "memory.pushes" }).optional,
    streams: tag<Streams>({ label: "memory.streams" }).optional,
    meta: tag<MetaOp>({ label: "memory.meta" }).optional,
    renew: tag<RenewOp>({ label: "memory.renew" }).optional,
  };

  const send = operation({
    label: "memory.send",
    input: sendInput,
    depends: { peer: peer.required, headers, protocol },
    run: async ({ peer, headers, protocol }, { input, obs }) => {
      const sent = { ...input.meta, ...protocol.traceparent(obs.span) }.traceparent;
      const req = new Request(`http://memory/${input.address}`, { headers });
      const session = peer.createSession({
        trace: traceparent.safeParse(sent).data ?? null,
        tags: [routes.request(req), requestStop(req.signal)],
      });
      const reply = await session.run(serve, { input }).finally(() => session.close());
      if (reply !== null) return reply;
      const payload = { status: 404 };

      throw Object.assign(new Error("TransportFailed"), { kind: "TransportFailed", payload });
    },
  });

  const open = operation({
    label: "memory.open",
    input: openInput,
    depends: { peer: peer.required, headers, protocol },
    run: async ({ peer, headers, protocol }, { input, signal, obs }): Promise<void> => {
      const sent = { ...input.meta, ...protocol.traceparent(obs.span) }.traceparent;
      const req = new Request(`http://memory/${input.address}`, { headers });
      const session = peer.createSession({
        trace: traceparent.safeParse(sent).data ?? null,
        tags: [routes.request(req), requestStop(req.signal)],
      });
      await session
        .run(serveStream, { input: { ...input, left: signal } })
        .finally(() => session.close());
    },
  });

  /** What rpc and remoteData run: a value out, the reply (or the pushes) back. */
  const call = operation({
    label: "memory.call",
    input: callInput,
    run: (): Promise<Reply> => {
      throw new Error("memory: no transport here");
    },
  }) as Call;

  const watch = operation({
    label: "memory.watch",
    input: watchInput,
    run: (): Promise<void> => {
      throw new Error("memory: no transport here");
    },
  }) as Watch;

  const clientHeld = data<{ side: ClientSide; protocol: Protocol } | null>({
    label: "transport.client",
    initial: null,
  });

  const client = capsule({
    label: "memory",
    config: { peer: peer.required, headers, ...keys },
    exports: { call, watch },
    hooks: {
      async start({ config, load, next }) {
        const p = await load(protocol, kept);
        const { codec, pushes, streams, meta, renew } = config;
        load(clientHeld, kept).set({
          protocol: p,
          side: {
            send,
            open,
            codec: p.given(codec) ?? p.json,
            pushes: p.given(pushes),
            streams: p.given(streams),
            meta: p.given(meta),
            renew: p.given(renew),
          },
        });
        return next();
      },
      run({ op, call: invocation, run, log, load, next }): unknown {
        if (op !== call && op !== watch) return next();
        const { side, protocol: p } = load(clientHeld, kept).get()!;
        const hook = { run, log, signal: invocation?.signal };
        const input = (invocation?.input ?? invocation?.rawInput) as never;
        return op === call ? p.callOver(side, hook, input) : p.watchOver(side, hook, input);
      },
    },
  });

  const serverHeld = data<{ side: ServerSide; protocol: Protocol } | null>({
    label: "transport.server",
    initial: null,
  });

  const server = capsule({
    label: "memory.server",
    config: {
      codec: tag<Codec>({ label: "memory.codec" }).optional,
      services: tag<readonly Service[]>({ label: "memory.services" }).required,
    },
    exports: { serve, serveStream },
    hooks: {
      async start({ config, load, next, raise }) {
        const p = await load(protocol, kept);
        const routesOf = p.routesOf(config.services, raise as never);
        const side = { codec: p.given(config.codec) ?? p.json, routes: routesOf };
        load(serverHeld, kept).set({ side, protocol: p });
        return next();
      },
      run({ op, call: invocation, run, log, load, next }): unknown {
        if (op !== serve && op !== serveStream) return next();
        const { side, protocol: p } = load(serverHeld, kept).get()!;
        const hook = { run, log, signal: invocation?.signal };
        const input = (invocation?.input ?? invocation?.rawInput) as never;
        return op === serve ? p.serveText(side, hook, input) : p.streamText(side, hook, input);
      },
    },
  });

  return {
    client: client as unknown as Omit<typeof client, never> & {
      readonly call: Call;
      readonly watch: Watch;
      (values: ClientConfig): ReturnType<typeof client>;
    },
    server: server as unknown as Omit<typeof server, never> & {
      readonly serve: TextServe;
      readonly serveStream: TextStream;
      (values: { codec?: Codec; services: readonly Service[] }): ReturnType<typeof server>;
    },
  };
}

/** The default memory transport. */
export const memory = createMemory();
