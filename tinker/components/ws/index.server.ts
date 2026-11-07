import { capsule, data, operation, tag } from "@tinker/core";
import type { Scope } from "@tinker/core";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { z } from "zod";

import { kept, openInput, protocol, sendInput } from "~/components/protocol";
import type {
  BytesLimit,
  Codec,
  Protocol,
  ServerSide,
  Service,
  TextServe,
  TextStream,
} from "~/components/protocol";
import { requestStop } from "~/components/requests";
import { routes, traceparent } from "~/components/requests/index.server";

import { frameMax } from "./index";

// The WebSocket transport, server side: one socket per client, on Bun's own WebSocket.
// Frames are JSON arrays of messages (see the client). Each call and each watch runs in its own
// session of the scope, as an HTTP request does, with the upgrade request bound. The answers and
// pushes of one tick go out as one frame per socket, so one write's keys arrive together (F35).
//
// Guards (OWASP WebSocket cheat sheet, Bun limits, tRPC maxBatchSize):
// - the Origin check at upgrade: a browser sends cookies on a cross-site upgrade (CSWSH);
// - a frame over `maxPayload`, or not an array of at most 32 messages, closes the socket;
// - a slow reader past `maxPayload` of unsent bytes is closed, not buffered without end;
// - more than `maxWatches` live watches answers that watch with 429;
// - a socket quiet for 60 s is closed (Bun pings it first).
//
// Bytes come on their own POST, `<path>/<address>`, for a key with a bytes field only. Before it
// reads one byte (Fastify's bodyLimit, under-pressure, OWASP file upload cheat sheet):
// - 404 for a key with no bytes field: nothing else takes a POST;
// - 403 for a foreign Origin; 400 with no `x-input`, a header a cross-site form cannot set
//   without a CORS preflight, and this server answers no preflight;
// - 431 for `x-input` or `x-meta` over 2 KiB; 415 for a type the key does not list;
// - 413 when Content-Length says more than the key's max;
// - 503 with Retry-After when `maxUploads` POSTs run already.
// Then the implementation gets the body lazily: the stream is read only when it reads, counted
// (413 once past the max, whatever Content-Length said), and cut at `uploadDeadline`. The onStart
// hooks run first, so a refused call never reads the body; an unread body is cancelled.

type ServerConfig = {
  path: string;
  services: readonly Service[];
  codec?: Codec;
  origin?: string | null;
  maxPayload?: number;
  maxWatches?: number;
  maxUploads?: number;
  uploadDeadline?: number;
  strict?: boolean;
};

type Msg = { i: number; a?: string; t?: string; m?: Record<string, string>; w?: 1; x?: 1 };

/** What each socket holds: its upgrade request, scope, live watches, this tick's frame, steps. */
type Socket = {
  req: Request;
  scope: Scope.Handle;
  gone: AbortController;
  watches: Map<number, AbortController>;
  out: unknown[];
  emit: (ws: ServerWebSocket<Socket>, message: unknown) => void;
  pusher: (ws: ServerWebSocket<Socket>, i: number) => (text: string) => void;
  one: (ws: ServerWebSocket<Socket>, m: Msg) => Promise<unknown>;
  run: (ws: ServerWebSocket<Socket>, m: Msg) => Promise<unknown>;
};

/** Makes one WebSocket server. */
export function createWs() {
  const path = tag<string>({ label: "ws.path" });
  const codec = tag<Codec>({ label: "ws.codec" }).optional;
  const services = tag<readonly Service[]>({ label: "ws.services" }).required;
  const strict = tag<boolean>({ label: "ws.strict", default: false });
  /** The public origin a socket comes from. Unset, it is the request URL's own origin; behind a
   * TLS proxy that is `http://<host>`, so the app binds its public `https` origin here. */
  const origin = tag<string | null>({ label: "ws.origin", default: null });
  /** The largest frame in, and the most unsent bytes out, per socket (1 MiB). */
  const maxPayload = tag<number>({
    label: "ws.maxPayload",
    default: 1_048_576,
    parse: (raw) => {
      if (!Number.isSafeInteger(raw) || Number(raw) <= 0) {
        throw new TypeError("not a positive whole number of bytes");
      }
      return Number(raw);
    },
  });
  const maxWatches = tag<number>({ label: "ws.maxWatches", default: 256 });
  /** The most bytes POSTs at once, on this server. */
  const maxUploads = tag<number>({ label: "ws.maxUploads", default: 8 });
  /** The most time a bytes POST may take, in ms (5 min). */
  const uploadDeadline = tag<number>({ label: "ws.uploadDeadline", default: 300_000 });

  const serve = operation({
    label: "ws.serve",
    input: sendInput,
    run: (): Promise<string | null> => {
      throw new Error("ws: no server here");
    },
  }) as TextServe;

  const serveStream = operation({
    label: "ws.serveStream",
    input: openInput,
    run: (): Promise<boolean> => {
      throw new Error("ws: no server here");
    },
  }) as TextStream;

  /**
   * A bytes POST's body: the request's stream, read once and only when the implementation reads
   * it, counted (`over` once past `max`, whatever Content-Length said) and cut at `stop`.
   */
  const bodyOf = operation({
    label: "ws.body",
    input: z.object({
      req: z.instanceof(Request),
      max: z.number(),
      type: z.string(),
      stop: z.instanceof(AbortSignal),
    }),
    run: (_, { input: { req, max, type, stop } }) => ({
      type,
      read: false,
      seen: 0,
      over: false,
      stream(): ReadableStream<Uint8Array> {
        if (this.read) throw new TypeError("The body was read already.");
        this.read = true;
        const counted = new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, out) => {
            this.seen += chunk.byteLength;
            if (this.seen <= max) return out.enqueue(chunk);
            this.over = true;
            out.error(new RangeError("The body is over its max."));
          },
        });
        return (req.body ?? new Blob().stream()).pipeThrough(counted, { signal: stop });
      },
      bytes() {
        return new Response(this.stream()).bytes();
      },
      text() {
        return new Response(this.stream()).text();
      },
      arrayBuffer() {
        return new Response(this.stream()).arrayBuffer();
      },
    }),
  });

  /**
   * The guards of a bytes POST, before a byte is read: the first that fails answers, in the order
   * of the comment at the top. Else the call's text, meta and type, read off the headers.
   */
  const admit = operation({
    label: "ws.admit",
    input: z.object({
      req: z.instanceof(Request),
      limit: z.custom<BytesLimit>().optional(),
      origin: z.string(),
      busy: z.boolean(),
    }),
    run: async (_, { input: { req, limit = { max: 0, types: [] }, origin, busy } }) => {
      const h = Object.fromEntries(req.headers) as Record<string, string | undefined>;
      const type = String(h["content-type"]).split(";")[0]!.trim().toLowerCase();
      const meta = await Promise.resolve(h["x-meta"] ?? "{}")
        .then(JSON.parse)
        .catch(() => null);
      const guards: [boolean, number][] = [
        [limit.max > 0, 404],
        [[undefined, origin].includes(h.origin), 403],
        [h["x-input"] !== undefined, 400],
        [String(h["x-input"]).length <= 2048 && String(h["x-meta"]).length <= 2048, 431],
        [z.record(z.string(), z.string()).safeParse(meta).success, 400],
        [limit.types.includes(type), 415],
        [!(Number(h["content-length"]) > limit.max), 413],
        [!busy, 503],
      ];
      const status = guards.find(([ok]) => !ok)?.[1];
      if (!status) {
        return { text: String(h["x-input"]), meta: meta as Record<string, string>, type };
      }

      return new Response(null, {
        status,
        headers: status === 503 ? { "retry-after": "1" } : undefined,
      });
    },
  });

  const held = data<{ side: ServerSide; protocol: Protocol } | null>({
    label: "transport.server",
    initial: null,
  });

  /**
   * The server. Its start gives `{ upgrade, websocket }`: the host calls `upgrade` from its fetch
   * (undefined: not this path; null: upgraded, Bun owns the request now) and passes `websocket`
   * to `Bun.serve`.
   */
  const server = capsule({
    label: "ws.server",
    config: {
      path: path.required,
      origin,
      codec,
      services,
      strict,
      maxPayload,
      maxWatches,
      maxUploads,
      uploadDeadline,
    },
    hooks: {
      async start({ config, load, next, raise, log }) {
        const allowed = config.origin === null ? "" : String(URL.parse(config.origin)?.origin);
        if (!/^(https?:\/\/|$)/.test(allowed)) {
          raise("MissingConfig", { label: "ws.server", key: "origin" });
        }
        const p = await load(protocol, kept);
        const routesOf = p.routesOf(config.services, raise as never, log, config.strict);
        const side = { codec: p.given(config.codec) ?? p.json, routes: routesOf };
        /** The addresses that take bytes, with their limits, from the service that owns each. */
        const uploadsAt = new Map(
          [...routesOf].flatMap(([address, one]) => {
            const limit = one.uploads?.[address];
            return limit ? [[address, limit] as const] : [];
          }),
        );
        load(held, kept).set({ side, protocol: p });
        await next();

        const upgrade = (
          req: Request,
          scope: Scope.Handle,
          bun: Server<Socket>,
        ): Response | null | undefined => {
          const url = new URL(req.url);
          if (url.pathname !== config.path) return undefined;
          if (![null, new URL(allowed, url).origin].includes(req.headers.get("origin"))) {
            return new Response(null, { status: 403 });
          }
          // Per socket: its request, scope, live watches, this tick's frame, and its steps.
          const own: Socket = {
            req,
            scope,
            gone: new AbortController(),
            watches: new Map(),
            out: [],
            /** Queues one message; the first of a tick schedules the frame. */
            emit(ws, message) {
              if (own.gone.signal.aborted || own.out.push(message) > 1) return;
              // setImmediate, not setTimeout(0): Bun waits at least 1 ms for a timer (measured: +1.1 ms
              // and +11% CPU on a lone call). The answers of one tick still go as one frame.
              setImmediate(() => {
                if (!own.gone.signal.aborted) ws.send(JSON.stringify(own.out.splice(0)));
              });
            },
            pusher(ws, i) {
              return (t: string) => own.emit(ws, { i, t });
            },
            /** One message: a stop, or a call or watch that fits. */
            async one(ws, m) {
              if (m.x) return own.watches.get(m.i)?.abort();
              const bad = typeof m.a !== "string" || typeof m.t !== "string";
              const full = !!m.w && own.watches.size >= config.maxWatches;
              if (bad || full) return own.emit(ws, { i: m.i, e: bad ? 400 : 429 });
              return own.run(ws, m);
            },
            /** A call or a watch, in its own session of the scope. */
            async run(ws, m) {
              const meta = Object(m.m) as Record<string, string>;
              const trace = traceparent.safeParse(meta.traceparent).data ?? null;
              const stop = new AbortController();
              const left = AbortSignal.any([stop.signal, own.gone.signal]);
              const tags = [routes.request(req), requestStop(left)];
              const session = await Promise.resolve()
                .then(() => scope.createSession({ trace, tags }))
                .catch(() => null);
              if (!session) return own.emit(ws, { i: m.i, e: 503 });

              const input = { address: String(m.a), text: String(m.t), meta };
              if (!m.w) {
                const reply = await session.run(serve, { input }).finally(() => session.close());
                return own.emit(ws, reply === null ? { i: m.i, e: 404 } : { i: m.i, t: reply });
              }

              own.watches.set(m.i, stop);
              const push = own.pusher(ws, m.i);
              await Promise.resolve(session.run(serveStream, { input: { ...input, left, push } }))
                .then((found) => own.emit(ws, found ? { i: m.i, end: 1 } : { i: m.i, e: 404 }))
                .catch((error) => {
                  log.error("ws stream failed", { address: m.a, cause: String(error) });
                  own.emit(ws, { i: m.i, end: 1 });
                })
                .finally(() => (own.watches.delete(m.i), void session.close()));
            },
          };
          return bun.upgrade(req, { data: own }) ? null : new Response(null, { status: 426 });
        };

        /** The bytes POSTs running now. */
        let uploading = 0;

        /**
         * A bytes POST: undefined when it is not one (not this path), else the reply. The guards
         * run in the order of the comment at the top; the body is read only by the implementation.
         */
        const post = async (req: Request, scope: Scope.Handle): Promise<Response | undefined> => {
          const url = new URL(req.url);
          const address = decodeURIComponent(url.pathname.slice(config.path.length + 1));
          const limit = uploadsAt.get(address);
          if (req.method !== "POST" || !url.pathname.startsWith(`${config.path}/`)) return;

          const busy = uploading >= config.maxUploads;
          const origin = new URL(allowed, url).origin;
          const admitted = await scope.run(admit, { input: { req, limit, origin, busy } });
          if (admitted instanceof Response) return admitted;

          const { text, meta, type } = admitted;
          const stop = AbortSignal.any([req.signal, AbortSignal.timeout(config.uploadDeadline)]);
          const trace = traceparent.safeParse(meta.traceparent).data ?? null;
          const tags = [routes.request(req), requestStop(stop)];
          const session = await Promise.resolve()
            .then(() => scope.createSession({ trace, tags }))
            .catch(() => null);
          if (!session) return new Response(null, { status: 503 });

          uploading += 1;
          const body = session.run(bodyOf, { input: { req, max: limit!.max, type, stop } });
          const reply = await session
            .run(serve, { input: { address, text, meta, body } })
            .finally(() => {
              uploading -= 1;
              // An unread body is cancelled; a read one is locked, and its cancel is a no-op.
              void req.body?.cancel().catch(() => undefined);
              return session.close();
            });
          if (body.over) return new Response(null, { status: 413 });
          if (reply === null) return new Response(null, { status: 404 });
          return new Response(reply, {
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        };

        const websocket: WebSocketHandler<Socket> = {
          maxPayloadLength: config.maxPayload,
          backpressureLimit: config.maxPayload,
          closeOnBackpressureLimit: true,
          idleTimeout: 60,
          sendPings: true,
          message(ws, frame) {
            const all = Promise.resolve(typeof frame === "string" ? frame : "")
              .then((text) => JSON.parse(text) as Msg[])
              .catch(() => null);
            void all.then((msgs) => {
              const fits =
                Array.isArray(msgs) &&
                msgs.length <= frameMax &&
                msgs.every((m) => Number.isSafeInteger(Object(m).i));
              if (!fits) return ws.close(1008, "bad frame");
              for (const m of msgs) {
                void ws.data
                  .one(ws, m)
                  .catch((error) => log.error("ws message failed", { error: String(error) }));
              }
            });
          },
          close(ws) {
            ws.data.gone.abort(new Error("socket closed"));
          },
        };
        /** The largest body any key takes: the host sets Bun's `maxRequestBodySize` from it. */
        const maxBody = Math.max(
          0,
          ...[...routesOf.values()]
            .flatMap((one) => Object.values(one.uploads ?? {}))
            .map((l) => l.max),
        );
        return { upgrade, post, websocket, maxBody };
      },
      run({ op, call: invocation, run, log, load, next }): unknown {
        if (op !== serve && op !== serveStream) return next();
        const { side, protocol: p } = load(held, kept).get()!;
        const hook = { run, log, signal: invocation?.signal };
        const input = (invocation?.input ?? invocation?.rawInput) as never;
        return op === serve ? p.serveText(side, hook, input) : p.streamText(side, hook, input);
      },
    },
  });

  return {
    server: server as unknown as Omit<typeof server, never> & {
      (values: ServerConfig): ReturnType<typeof server>;
    },
  };
}

/** The default WebSocket server. */
export const ws = createWs();
