import { createScope, operation, tag } from "@tinker/core";
import type { Resource } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import {
  auth,
  authSettings,
  authStartup,
  handleAuth,
  sendAuthMail,
  sessionDeleted,
} from "~/components/auth/index.server";
import { betterAuthModule, betterAuthDrizzle, betterAuthStart } from "~/components/auth/modules";
import { database } from "~/components/database/index.server";

const marker = tag<string>({ label: "proof.call", default: "outside" });
const authModule: Resource.Handle<Promise<unknown>> = betterAuthModule;
const adapterModule: Resource.Handle<Promise<unknown>> = betterAuthDrizzle;
const startModule: Resource.Handle<Promise<unknown>> = betterAuthStart;
const databasePort: Resource.Handle<Promise<unknown>> = database;

type Hooks = {
  emailVerification: {
    sendVerificationEmail(input: { user: { email: string }; url: string }): Promise<void>;
  };
  databaseHooks: { session: { delete: { after(input: { userId: string }): Promise<void> } } };
};

test("auth hooks use their live request context, isolate concurrent calls, and use root context only outside a live flow", async () => {
  const first = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const detached = Promise.withResolvers<void>();
  const detachedDone = Promise.withResolvers<void>();

  const seen: string[] = [];
  let hooks: Hooks | undefined;
  const app = createScope({
    extensions: [authStartup],
    tags: [
      authSettings({ origin: "http://proof.test", secret: "s".repeat(32) }),
      sendAuthMail((_message, ctx) => {
        seen.push(`send:${ctx.resolve(marker)}`);
      }),
      sessionDeleted(async (_account, ctx) => {
        seen.push(`delete:${ctx.resolve(marker)}`);
      }),
    ],
    presets: [
      preset(databasePort, async () => ({})),
      preset(adapterModule, async () => ({ drizzleAdapter: () => ({}) })),
      preset(startModule, async () => ({ tanstackStartCookies: () => ({}) })),
      preset(authModule, async () => ({
        betterAuth(options: Hooks) {
          hooks = options;
          return {
            async handler(request: Request) {
              if (request.headers.has("x-first")) {
                first.resolve();
                await release.promise;
              }
              if (request.headers.has("x-detach")) {
                void detached.promise.then(async () => {
                  await options.emailVerification.sendVerificationEmail({
                    user: { email: "proof@example.com" },
                    url: "http://proof.test",
                  });
                  detachedDone.resolve();
                });
                return new Response("detached");
              }

              await options.emailVerification.sendVerificationEmail({
                user: { email: "proof@example.com" },
                url: "http://proof.test",
              });
              await options.databaseHooks.session.delete.after({ userId: "proof" });
              return new Response("sent");
            },
            api: { getSession: async () => null },
          };
        },
      })),
    ],
  });
  await app.ready;
  try {
    const left = app.run(handleAuth, {
      input: new Request("http://proof.test", { headers: { "x-first": "yes" } }),
      tags: marker("first"),
    });
    await first.promise;
    await app.run(handleAuth, { input: new Request("http://proof.test"), tags: marker("second") });
    release.resolve();
    await left;
    expect(seen).toEqual(["send:second", "delete:second", "send:first", "delete:first"]);

    await app.run(handleAuth, {
      input: new Request("http://proof.test", { headers: { "x-detach": "yes" } }),
      tags: marker("finished"),
    });
    detached.resolve();
    await detachedDone.promise;
    await hooks!.databaseHooks.session.delete.after({ userId: "background" });
    expect(seen.slice(-2)).toEqual(["send:outside", "delete:outside"]);
    expect(await app.resolve(auth)).toBeDefined();
  } finally {
    await app.close({ graceful: true });
  }
});

test("authStartup makes app-root runs async", async () => {
  const app = createScope({
    extensions: [authStartup],
    tags: [
      authSettings({ origin: "http://proof.test", secret: "s".repeat(32) }),
      sendAuthMail(() => {}),
      sessionDeleted(async () => {}),
    ],
  });
  await app.ready;
  try {
    const result = app.run(operation({ label: "proof.sync", run: () => 1 }));
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(1);
  } finally {
    expect((await app.close({ graceful: true })).status).toBe("success");
  }
});
