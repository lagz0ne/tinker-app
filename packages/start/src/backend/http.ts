import { operation, resource } from "@tinker/core";
import { z } from "zod";
import { raise } from "../errors";
import { httpBackend } from "./http-backend";
import { backendStop, requestStop } from "./lifetime";

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

/** Closing this session or an ancestor ends HTTP waits before graceful work drains.
 * Stop tags also end waits without closing a layer; caller cancellation keeps Core's result. */
export const http = resource({
  label: "http",
  target: "session",
  depends: {
    send: httpBackend,
    backendStop: backendStop.optional,
    requestStop: requestStop.optional,
  },
  factory: ({ send, backendStop, requestStop }, { closing, defer }) => {
    const stop = new AbortController();
    defer(() => stop.abort());
    return {
      async send(url: string, init: RequestInit & { signal: AbortSignal }) {
        const signal = AbortSignal.any([
          init.signal,
          closing,
          stop.signal,
          ...(backendStop.present ? [backendStop.value] : []),
          ...(requestStop.present ? [requestStop.value] : []),
        ]);
        signal.throwIfAborted();
        const response = await send(url, { ...init, signal });
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

/** HTTP statuses are results; only sending or reading failures raise HttpRequestFailed. */
export const httpRequest = operation({
  label: "http.request",
  input: requestShape,
  depends: { http },
  run: ({ http }, { input, obs, signal }) => {
    const { url, method, headers, body } = input;
    const path = new URL(url).pathname;
    return obs.child(`http ${method} ${path}`, async (span) => {
      if (span) {
        span.attributes["http.request.method"] = method;
        span.attributes["url.path"] = path;
      }
      try {
        const response = await http.send(url, { method, headers, body, signal: signal });
        if (span) span.attributes["http.response.status_code"] = response.status;
        return response;
      } catch (cause) {
        signal.throwIfAborted();
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
