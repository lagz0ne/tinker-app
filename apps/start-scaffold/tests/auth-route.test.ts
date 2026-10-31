import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { handleAuth } from "~/components/auth/index.server";

import { Route } from "@/routes/api.auth.$";

const handlers = Route.options.server?.handlers;
const pathname = "/api/auth/$" as const;

test("the auth route answers with the auth reply, and a stopped call raises Cancelled", async () => {
  const root = createScope({
    presets: [preset(handleAuth, async (_deps, { input }) => new Response(input.url))],
  });
  const session = root.createSession();
  const request = new Request("http://app/api/auth/get-session");
  if (!handlers || typeof handlers === "function") return expect.unreachable("auth has handlers");
  const call = (signal: AbortSignal) => ({
    request,
    params: { _splat: "get-session" },
    pathname,
    next: () => expect.unreachable("the route answers itself"),
    context: { session, signal },
  });

  const reply = await handlers.GET?.(call(request.signal));
  expect(reply).toBeInstanceOf(Response);
  const stop = new AbortController();
  stop.abort();
  await expect(handlers.POST?.(call(stop.signal))).rejects.toMatchObject({
    kind: "Cancelled",
    payload: {},
  });
  await session.close();
});
