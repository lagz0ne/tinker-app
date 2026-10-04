import { operation, resource } from "@tinker/core";
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

/** A session owns each request through body reading, including on graceful close. */
export const http = resource({
  label: "http",
  target: "session",
  depends: { send: httpBackend },
  factory: ({ send }, ctx) => {
    const requests = new Set<AbortController>();
    ctx.defer(() => {
      for (const request of requests) request.abort();
    });
    return {
      async send(url: string, init: RequestInit & { signal: AbortSignal }) {
        const stop = new AbortController();
        requests.add(stop);
        try {
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
        } finally {
          requests.delete(stop);
        }
      },
    };
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
