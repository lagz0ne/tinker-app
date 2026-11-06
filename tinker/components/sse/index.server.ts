import { capsule, data, operation, tag } from "@tinker/core";
import type { Scope } from "@tinker/core";

import { kept, openInput, protocol, sendInput } from "~/components/protocol";
import type {
  Codec,
  Protocol,
  ServerSide,
  Service,
  TextServe,
  TextStream,
} from "~/components/protocol";
import { requestStop } from "~/components/requests";
import { routes, traceparent } from "~/components/requests/index.server";

// The SSE transport, server side: a capsule that answers the protocol over HTTP.
// A call = POST <base>/<address> (body = text); a watch = GET <base>/<address>?text= as an event
// stream, one `data:` line per text. `meta` comes as `x-meta-*` headers.

type ServerConfig = {
  base: string;
  services: readonly Service[];
  codec?: Codec;
  origin?: string | null;
  maxBody?: number;
  /** Two services with one address fail start (DuplicateAddress). Unset: the first wins. */
  strict?: boolean;
};

/** Makes one SSE server. A scope can hold two (a public base and a signed base). */
export function createSse() {
  const base = tag<string>({ label: "sse.base" });
  const codec = tag<Codec>({ label: "sse.codec" }).optional;
  const services = tag<readonly Service[]>({ label: "sse.services" }).required;
  const strict = tag<boolean>({ label: "sse.strict", default: false });

  /** The public origin a client calls from. Unset, it is the request URL's own origin; behind a
   * TLS proxy that is `http://<host>`, so the app binds its public `https` origin here. A bound
   * value that is not an http(s) URL fails start with `MissingConfig { key: "origin" }`. */
  const origin = tag<string | null>({ label: "sse.origin", default: null });

  /** The largest call body read, in bytes (1 MiB unset). A bigger one answers 413, and its
   * service never runs: a `content-length` over it is refused unread, and a body with no length
   * is read only up to it. It must be a positive whole number, or `Infinity` for no cap; anything
   * else (NaN from a bad `Number(env.X)`, 0, -1, 1.5) fails start with `DataValidationFailed`. */
  const maxBody = tag<number>({
    label: "sse.maxBody",
    default: 1_048_576,
    parse: (raw) => {
      const ok = raw === Infinity || (Number.isSafeInteger(raw) && Number(raw) > 0);
      if (!ok) throw new TypeError("not a positive whole number of bytes, or Infinity");
      return Number(raw);
    },
  });

  /** What each request runs, in its own session. */
  const serve = operation({
    label: "sse.serve",
    input: sendInput,
    run: (): Promise<string | null> => {
      throw new Error("sse: no server here");
    },
  }) as TextServe;

  const serveStream = operation({
    label: "sse.serveStream",
    input: openInput,
    run: (): Promise<boolean> => {
      throw new Error("sse: no server here");
    },
  }) as TextStream;

  const held = data<{ side: ServerSide; protocol: Protocol } | null>({
    label: "transport.server",
    initial: null,
  });

  /**
   * The server: `services` by address, at `base`. Its start gives the request handler.
   * A request with an `Origin` header must come from `origin` when it is bound, else from the
   * request URL's origin; one with none passes. Each request runs in its own session of `scope`,
   * with the request bound (`routes.request`): a valid `traceparent` makes it the child of the
   * client's span; no header, or a bad one, starts a fresh trace. A closing root answers 503.
   */
  const server = capsule({
    label: "sse.server",
    config: { base: base.required, origin, maxBody, codec, services, strict },
    hooks: {
      async start({ config, load, next, raise, log }) {
        // Unset is "": it resolves to the request URL's own origin. Bound, it must be an
        // http(s) URL: a bad URL is "undefined", and any other scheme's origin is "null".
        const allowed = config.origin === null ? "" : String(URL.parse(config.origin)?.origin);
        if (!/^(https?:\/\/|$)/.test(allowed)) {
          raise("MissingConfig", { label: "sse.server", key: "origin" });
        }

        const p = await load(protocol, kept);
        const routesOf = p.routesOf(config.services, raise as never, log, config.strict);
        const side = { codec: p.given(config.codec) ?? p.json, routes: routesOf };
        load(held, kept).set({ side, protocol: p });
        await next();
        return handle;

        /** A path outside `base` answers undefined; the host tries its other routes. */
        async function handle(req: Request, scope: Scope.Handle): Promise<Response | undefined> {
          const url = new URL(req.url);
          if (!url.pathname.startsWith(`${config.base}/`)) return undefined;
          // A call is a POST, a watch a GET: any other method changes nothing here.
          if (!["POST", "GET"].includes(req.method)) {
            return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
          }
          if (![null, new URL(allowed, url).origin].includes(req.headers.get("origin"))) {
            return new Response(null, { status: 403 });
          }

          // Counts the bytes as they come, so a body with no length stops at the cap. A body that
          // errors mid-read is the empty text, which the codec cannot read (decode).
          const text =
            req.method === "POST"
              ? await Promise.resolve(req)
                  .then(async ({ headers, body }) => {
                    if (Number(headers.get("content-length")) > config.maxBody) return undefined;
                    const chunks: Uint8Array[] = [];
                    let size = 0;
                    for await (const chunk of body ?? []) {
                      size += chunk.byteLength;
                      if (size > config.maxBody) return undefined;
                      chunks.push(chunk);
                    }
                    return new TextDecoder().decode(Buffer.concat(chunks));
                  })
                  .catch(() => "")
              : (url.searchParams.get("text") ?? "");
          if (text === undefined) return new Response(null, { status: 413 });

          const address = url.pathname.slice(config.base.length + 1);
          const headers = [...req.headers].flatMap(([k, v]) =>
            k.startsWith("x-meta-") ? [[k.slice(7), v]] : k === "traceparent" ? [[k, v]] : [],
          );
          const meta: Record<string, string> = Object.fromEntries(headers);
          const trace = traceparent.safeParse(req.headers.get("traceparent")).data ?? null;
          const tags = [routes.request(req), requestStop(req.signal)];
          // A closing root throws `Disposed` from createSession: the request answers 503.
          return Promise.resolve()
            .then(() => scope.createSession({ trace, tags }))
            .then(
              async (session) => {
                if (req.method === "POST") {
                  const reply = await session
                    .run(serve, { input: { address, text, meta } })
                    .finally(() => session.close());
                  return reply === null ? new Response(null, { status: 404 }) : new Response(reply);
                }

                // The stream's start lasts as long as the run; then the body closes.
                const enc = new TextEncoder();
                const body = new ReadableStream<Uint8Array>({
                  start(out) {
                    out.enqueue(enc.encode(": open\n\n"));
                    const push = (t: string) =>
                      out.enqueue(enc.encode(`data: ${JSON.stringify(t)}\n\n`));
                    return Promise.resolve(
                      session.run(serveStream, {
                        input: { address, text, meta, push, left: req.signal },
                      }),
                    )
                      .catch((error) => {
                        log.error("sse stream failed", { address, cause: String(error) });
                      })
                      .finally(() => {
                        void session.close();
                        try {
                          out.close();
                        } catch {}
                      });
                  },
                });
                return new Response(body, { headers: { "content-type": "text/event-stream" } });
              },
              () => new Response(null, { status: 503 }),
            )
            .catch(() => new Response(null, { status: 503 })); // the root closed mid-request
        }
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

/** The default SSE server. */
export const sse = createSse();
