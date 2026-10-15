import type { Resource } from "@tinker/core";
import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { auth, handleAuth, sendAuthMail, sessionDeleted } from "~/components/auth/index.server";
import { authSettings, authStartup } from "~/components/auth/index.server";
import { backendStop as requestHostStop } from "~/components/requests";
import { startRequests } from "~/components/requests";

import { bindings } from "./fixtures/app.server";
import type { AuthPort } from "./fixtures/app.server";

const requestBindings = requestHostStop(new AbortController().signal);

const hooks = [sendAuthMail(() => {}), sessionDeleted(async () => {})];

/** The same auth descriptor, typed only to the two methods the mount uses. */
const authPort: Resource.Handle<Promise<AuthPort>> = auth;

const proofAuth = preset(authPort, async () => ({
  handler: async (request: Request) =>
    Response.json({ method: request.method, path: new URL(request.url).pathname }),
  api: { getSession: async () => null },
}));

const keys = authSettings({ origin: "https://shop.example", secret: "s".repeat(32) });

test("handleAuth hands the whole request to the auth library and returns its reply", async () => {
  const root = createScope({
    extensions: [startRequests],
    tags: [requestBindings, bindings],
    presets: [proofAuth],
  });
  await root.ready;
  const get = await root.settle(handleAuth, {
    input: new Request("http://app/api/auth/get-session"),
  });
  if (get.status !== "success") throw get;
  expect(await get.value.json()).toEqual({ method: "GET", path: "/api/auth/get-session" });

  const post = await root.settle(handleAuth, {
    input: new Request("http://app/api/auth/sign-in/email", { method: "POST", body: "{}" }),
  });
  if (post.status !== "success") throw post;
  expect(await post.value.json()).toEqual({ method: "POST", path: "/api/auth/sign-in/email" });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("handleAuth takes only a request, and a failing auth library fails the call", async () => {
  const lost = new Error("auth store lost");
  const root = createScope({
    tags: [requestBindings, bindings],
    extensions: [startRequests],
    presets: [
      preset(authPort, async () => ({
        handler: async () => {
          throw lost;
        },
        api: { getSession: async () => null },
      })),
    ],
  });
  await root.ready;

  expect((await root.settle(handleAuth, { rawInput: "/api/auth/get-session" })).status).toBe(
    "failed",
  );
  expect(
    await root.settle(handleAuth, { input: new Request("http://app/api/auth/get-session") }),
  ).toMatchObject({ status: "failed", error: lost });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("auth config is a typed tag and invalid config fails at binding", async () => {
  const root = createScope({ tags: keys });
  expect(root.resolve(authSettings)).toEqual({
    origin: "https://shop.example",
    secret: "s".repeat(32),
  });
  expect(() => authSettings({ origin: "ftp://shop.example", secret: "short" })).toThrow(
    expect.objectContaining({
      kind: "DataValidationFailed",
      payload: expect.objectContaining({ label: "auth.settings" }),
    }),
  );
  await root.close({ graceful: true });
});

test("with auth on, the app root does not start without the auth settings", async () => {
  const root = createScope({ extensions: [authStartup] });
  await expect(root.ready).rejects.toMatchObject({
    kind: "MissingTag",
    payload: { label: "auth.settings" },
  });
  expect((await root.close({ graceful: true })).status).toBe("failed");
});

test("with auth on and good keys, the app root starts with them read", async () => {
  const root = createScope({ extensions: [authStartup], tags: [keys, hooks] });
  await root.ready;
  expect(root.resolve(authSettings).origin).toBe("https://shop.example");
  expect(root.resolve(authStartup).kind).toBe("start");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("without auth startup, the app root reads no auth key or hook", async () => {
  const root = createScope({ observe: { history: 20 } });
  await root.ready;

  expect(root.resolve(authSettings.optional)).toEqual({ present: false });
  expect(() => root.resolve(authStartup)).toThrow(expect.objectContaining({ kind: "NotResolved" }));
  expect(root.spans()).toEqual([]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the auth part's work shows on the trace as handleAuth; its settings are a tag", async () => {
  const root = createScope({
    observe: { history: 20 },
    extensions: [authStartup, startRequests],
    tags: [requestBindings, [bindings, keys, hooks]],
    presets: [proofAuth],
  });
  await root.ready;
  expect(
    await root.settle(handleAuth, { input: new Request("http://app/api/auth/get-session") }),
  ).toMatchObject({ status: "success" });
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(root.spans().map(({ name }) => name)).toEqual([
    "module:node:async_hooks",
    "auth.calls",
    "auth",
    "handleAuth",
  ]);
});

test("missing app auth wiring reports the tag instead of importing the main", async () => {
  const root = createScope({ tags: requestBindings, extensions: [startRequests] });
  await root.ready;

  const result = await root.settle(handleAuth, {
    input: new Request("http://app/api/auth/get-session"),
  });

  expect(result).toMatchObject({
    status: "failed",
    error: { kind: "MissingTag", payload: { label: "database.url" } },
  });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("auth startup names each missing required hook before any auth client starts", async () => {
  for (const [provided, missing] of [
    [sessionDeleted(async () => {}), "auth.sendMail"],
    [sendAuthMail(() => {}), "auth.sessionDeleted"],
  ] as const) {
    const root = createScope({ extensions: [authStartup], tags: [keys, provided] });
    await expect(root.ready).rejects.toMatchObject({
      kind: "MissingTag",
      payload: { label: missing },
    });
    expect((await root.close({ graceful: true })).status).toBe("failed");
  }
});
