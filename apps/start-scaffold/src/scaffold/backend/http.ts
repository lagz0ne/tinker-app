import { extension, operation, resource } from "@tinker/core";
import type { Scope } from "@tinker/core";
import { z } from "zod";
import { raise } from "../errors.ts";
import { httpBackend } from "../http-backend.ts";

const requestShape = z
  .strictObject({
    url: z.url({ protocol: /^https?$/ }),
    method: z
      .string()
      .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)
      .toUpperCase(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
  })
  .brand<"HttpRequest">();

/** startRequests stops session-owned HTTP waits before a graceful close joins work. */
export const http = resource({
  label: "http",
  target: "session",
  depends: { send: httpBackend },
  factory: ({ send }, ctx) => {
    const stop = new AbortController();
    ctx.defer(() => stop.abort());
    return {
      close() {
        stop.abort();
      },
      async send(url: string, init: RequestInit & { signal: AbortSignal }) {
        stop.signal.throwIfAborted();
        const response = await send(url, {
          ...init,
          signal: AbortSignal.any([init.signal, stop.signal]),
        });
        return {
          status: response.status,
          headers: Object.fromEntries(
            Array.from(response.headers, ([name, value]): [string, string[]] => [
              name,
              name === "set-cookie" ? response.headers.getSetCookie() : [value],
            ]),
          ),
          body: await response.text(),
        };
      },
    };
  },
});

/** Core close hooks are root-only; this resource binds the same rule to child handles. */
const httpScopes = resource({
  label: "http.scopes",
  target: "session",
  depends: { requests: http },
  factory: (
    { requests },
    ctx,
  ): {
    bind(scope: Scope.Handle): void;
    stop(): void;
    close(options?: Scope.CloseOptions): Promise<Scope.Result>;
    createSession(options?: Scope.Options): Scope.Handle;
  } => {
    let close: Scope.Handle["close"];
    let createSession: Scope.Handle["createSession"];
    let closing: Promise<Scope.Result> | undefined;
    const children = new Set<{ stop(): void }>();
    ctx.defer(() => children.clear());
    const owned = {
      bind(this: void, scope: Scope.Handle) {
        close = scope.close.bind(scope);
        createSession = scope.createSession.bind(scope);
        scope.close = owned.close;
        scope.createSession = owned.createSession;
      },
      stop(this: void) {
        requests.close();
        for (const child of children) child.stop();
      },
      close(this: void, options?: Scope.CloseOptions) {
        if (closing) return closing;
        if (options?.graceful) owned.stop();
        return (closing = close(options));
      },
      createSession(this: void, options?: Scope.Options) {
        const child = createSession(options);
        const childOwner = child.resolve(httpScopes);
        childOwner.bind(child);
        children.add(childOwner);
        child.onClose(() => {
          children.delete(childOwner);
        });
        return child;
      },
    };
    return owned;
  },
});

/** startRequests composes this server hook without exporting the bound scope adapter. */
export const httpClosing = extension({
  label: "http.closing",
  hooks: {
    async start(event) {
      event.resolve(httpScopes).bind(event.scope);
      await event.next();
    },
  },
});

/** HTTP statuses are results; only sending or reading failures raise HttpRequestFailed. */
export const httpRequest = operation({
  label: "http.request",
  input: requestShape,
  depends: { http },
  run: ({ http }, ctx) => {
    const { url, method, headers, body } = ctx.input;
    const path = new URL(url).pathname;
    return ctx.obs.child(`http ${method} ${path}`, async (span) => {
      if (span) {
        span.attributes["http.request.method"] = method;
        span.attributes["url.path"] = path;
      }
      try {
        const response = await http.send(url, { method, headers, body, signal: ctx.signal });
        if (span) span.attributes["http.response.status_code"] = response.status;
        return response;
      } catch (cause) {
        ctx.signal.throwIfAborted();
        const failureShape = z.object({
          name: z.string().optional().catch(undefined),
          code: z.union([z.string(), z.number()]).optional().catch(undefined),
          cause: z.unknown().optional(),
        });
        const failure = failureShape.safeParse(cause);
        if (!failure.success) raise("HttpRequestFailed", { method, path });
        const nested = failureShape.safeParse(failure.data.cause);
        const details = nested.success ? nested.data : failure.data;
        raise("HttpRequestFailed", {
          method,
          path,
          cause: {
            name: details.name ?? failure.data.name,
            code: details.code ?? failure.data.code,
          },
        });
      }
    });
  },
});
