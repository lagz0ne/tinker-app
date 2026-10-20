import { createScope, type Observe } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import type { Database } from "~/components/database/index.server";

test("auth owns direct hooks, keeps read options, and logs only the failed user hook", async () => {
  const [
    { auth, liveAccount, principal },
    { betterAuthModule, betterAuthDrizzle, betterAuthStart },
    { authSettings },
    { database },
    { authMail },
    { requestHeaders },
    { createAccountStream, publishAccountNotice },
  ] = await Promise.all([
    import("~/components/auth/auth.server"),
    import("~/components/auth/modules"),
    import("~/components/auth/settings.server"),
    import("~/components/database/index.server"),
    import("~/components/mail/index.server"),
    import("~/components/requests/index.server"),
    import("~/components/sync/index.server"),
  ]);

  const streams: string[] = [];
  const notices: string[] = [];
  const messages: unknown[] = [];
  const logs: Observe.Log[] = [];
  const sessionCalls: unknown[] = [];
  const plugin = { id: "cookie-proof" };
  const adapter = { id: "pool-proof" };
  const error = new Error("stream unavailable");
  let refuse = false;
  let user: { id: string } | null = { id: "account-1" };
  type Config = {
    baseURL: string;
    secret: string;
    database: unknown;
    session: { deferSessionRefresh: boolean };
    plugins: unknown[];
    databaseHooks: {
      user: { create: { after: (input: { id: string }) => Promise<void> } };
      session: {
        create: { after: (input: { userId: string }) => Promise<void> };
        delete: { after: (input: { userId: string }) => Promise<void> };
      };
    };
    emailAndPassword: {
      enabled: boolean;
      sendResetPassword: (input: { user: { email: string }; url: string }) => Promise<void>;
    };
    emailVerification: {
      sendOnSignUp: boolean;
      sendVerificationEmail: (input: { user: { email: string }; url: string }) => Promise<void>;
    };
  };
  let config: Config | undefined;
  const db = {} as Database.Handle;
  const root = createScope({
    observe: { history: 30, log: (entry) => logs.push(entry) },
    tags: [authSettings({ origin: "https://auth.example.test", secret: "a".repeat(40) })],
    presets: [
      preset(database, async () => db),
      preset(authMail, () => ({
        enqueue: async (message: { to: string; subject: string; text: string }) => {
          messages.push(message);
        },
      })),
      preset(createAccountStream, async (_deps, { input }) => {
        streams.push(input.accountId);
        if (refuse) throw error;
      }),
      preset(publishAccountNotice, async (_deps, { input }) => {
        notices.push(input.accountId);
      }),
      preset(
        betterAuthModule,
        async () =>
          ({
            betterAuth: (options: Config) => {
              config = options;
              return {
                api: {
                  getSession: async (call: unknown) => {
                    sessionCalls.push(call);
                    return user ? { user } : null;
                  },
                },
              };
            },
          }) as unknown as typeof import("better-auth"),
      ),
      preset(
        betterAuthDrizzle,
        async () =>
          ({
            drizzleAdapter: (client: unknown, options: { provider: string; schema: unknown }) => {
              expect(client).toBe(db);
              expect(options.provider).toBe("pg");
              expect(options.schema).toHaveProperty("user");
              return adapter;
            },
          }) as unknown as typeof import("better-auth/adapters/drizzle"),
      ),
      preset(
        betterAuthStart,
        async () =>
          ({
            tanstackStartCookies: () => plugin,
          }) as unknown as typeof import("better-auth/tanstack-start"),
      ),
    ],
  });

  try {
    await root.ready;

    await root.resolve(auth);

    expect(config).toMatchObject({
      baseURL: "https://auth.example.test",
      secret: "a".repeat(40),
      database: adapter,
      session: { deferSessionRefresh: true },
      plugins: [plugin],
      emailAndPassword: { enabled: true },
      emailVerification: { sendOnSignUp: true },
    });

    await config!.databaseHooks.user.create.after({ id: "created" });

    refuse = true;

    await config!.databaseHooks.user.create.after({ id: "failed" });

    expect(logs.filter((entry) => entry.message === "auth.accountStreamFailed")).toMatchObject([
      { attributes: { accountId: "failed", error: "Error: stream unavailable" } },
    ]);

    await expect(
      config!.databaseHooks.session.create.after({ userId: "repair-failed" }),
    ).rejects.toBe(error);

    refuse = false;

    await config!.databaseHooks.session.create.after({ userId: "repaired" });

    await config!.databaseHooks.session.delete.after({ userId: "signed-out" });

    expect(streams).toEqual(["created", "failed", "repair-failed", "repaired"]);

    expect(notices).toEqual(["signed-out"]);

    const mail = { user: { email: "account@example.test" }, url: "https://auth.example.test/link" };

    await config!.emailAndPassword.sendResetPassword(mail);

    await config!.emailVerification.sendVerificationEmail(mail);

    expect(messages).toEqual([
      { to: mail.user.email, subject: "Reset your password", text: mail.url },
      { to: mail.user.email, subject: "Check your email", text: mail.url },
    ]);

    const headers = new Headers({ cookie: "proof=old" });
    for (const signedIn of [true, false]) {
      user = signedIn ? { id: "account-1" } : null;
      const session = root.createSession({ tags: [requestHeaders(headers)] });
      try {
        expect(await session.resolve(principal)).toEqual(user);
        expect(await session.run(liveAccount)).toBe(signedIn ? "account-1" : null);
      } finally {
        await session.close({ graceful: true });
      }
    }

    expect(sessionCalls).toEqual(
      Array.from({ length: 4 }, () => ({
        headers,
        query: { disableCookieCache: true, disableRefresh: true },
      })),
    );
  } finally {
    await root.close({ graceful: true });
  }
});
