import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";
import { auth } from "#tinker/app.server";
import { env } from "../src/env";
import { handleAuth } from "../src/parts/auth/handle.server";
import { auth as off } from "../src/parts/auth/off";
import { auth as on } from "../src/parts/auth/on.server";
import { authSettings, authStartup } from "../src/parts/auth/settings";

const keys = env({
  PUBLIC_ORIGIN: "https://shop.example",
  AUTH_SECRET: "s".repeat(32),
});

test("handleAuth hands the whole request to the app's auth library and returns its reply", async () => {
  const root = createScope();
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
    presets: [
      preset(auth, () => ({
        handler: async () => {
          throw lost;
        },
        api: { getSession: async () => null },
      })),
    ],
  });
  expect((await root.settle(handleAuth, { rawInput: "/api/auth/get-session" })).status).toBe(
    "failed",
  );
  expect(
    await root.settle(handleAuth, { input: new Request("http://app/api/auth/get-session") }),
  ).toMatchObject({ status: "failed", error: lost });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the part reads its two keys once and hands them to the app's auth library", async () => {
  const root = createScope({ tags: keys });
  expect(root.resolve(authSettings)).toEqual({
    origin: "https://shop.example",
    secret: "s".repeat(32),
  });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("an unset, empty, or refused key is named in one BadSettings", async () => {
  const unset = createScope({ tags: env({ PUBLIC_ORIGIN: "", AUTH_SECRET: undefined }) });
  expect(() => unset.resolve(authSettings)).toThrow(
    expect.objectContaining({
      kind: "BadSettings",
      payload: { part: "auth", keys: ["PUBLIC_ORIGIN", "AUTH_SECRET"] },
    }),
  );
  expect((await unset.close({ graceful: true })).status).toBe("success");
  const refused = createScope({
    tags: env({ PUBLIC_ORIGIN: "ftp://shop.example", AUTH_SECRET: "s".repeat(31) }),
  });
  expect(() => refused.resolve(authSettings)).toThrow(
    expect.objectContaining({ payload: { part: "auth", keys: ["PUBLIC_ORIGIN", "AUTH_SECRET"] } }),
  );
  expect((await refused.close({ graceful: true })).status).toBe("success");
});

test("with auth on, the app root does not start while an auth key is refused", async () => {
  const root = createScope({
    extensions: on.extensions,
    tags: env({ PUBLIC_ORIGIN: "https://shop.example", AUTH_SECRET: "short" }),
  });
  await expect(root.ready).rejects.toMatchObject({
    kind: "BadSettings",
    payload: { part: "auth", keys: ["AUTH_SECRET"] },
  });
  expect((await root.close({ graceful: true })).status).toBe("failed");
});

test("with auth on and good keys, the app root starts with them read", async () => {
  const root = createScope({ extensions: [authStartup], tags: keys });
  await root.ready;
  expect(root.resolve(authSettings).origin).toBe("https://shop.example");
  expect(on.extensions).toEqual([authStartup]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("with auth off, the app root reads no auth key", async () => {
  const root = createScope({ extensions: off.extensions, tags: env({}) });
  await root.ready;
  expect(off.extensions).toEqual([]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the auth part's work shows on the trace as auth.settings and handleAuth", async () => {
  const root = createScope({ observe: { history: 20 }, extensions: [authStartup], tags: keys });
  await root.ready;
  await root.settle(handleAuth, { input: new Request("http://app/api/auth/get-session") });
  expect(root.spans().map(({ name }) => name)).toEqual([
    "auth.settings",
    "test.auth",
    "handleAuth",
  ]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});
