import { operation, resource } from "@tinker/core";

import { database } from "~/components/database/index.server";
import { authMail } from "~/components/mail/index.server";
import { requestHeaders } from "~/components/requests/index.server";
import { createAccountStream, publishAccountNotice } from "~/components/sync/index.server";

import { betterAuthModule, betterAuthDrizzle, betterAuthStart } from "./modules";
import * as schema from "./schema.server";
import { authSettings } from "./settings.server";

/**
 * The root tracks each mail action; auth callbacks return before delivery.
 * A session delete sends the account notice after its commit: sign-out, a revoked or deleted
 * session, and a deleted user (its sessions go through the same delete) all end here.
 */
export const auth = resource({
  label: "auth",
  depends: {
    database,
    settings: authSettings,
    send: authMail,
    deleted: publishAccountNotice,
    created: createAccountStream,
    auth: betterAuthModule,
    adapter: betterAuthDrizzle,
    start: betterAuthStart,
  },
  factory: async (
    { database, settings, send, deleted, created, auth, adapter, start },
    { log },
  ) => {
    const { betterAuth } = auth;
    const { drizzleAdapter } = adapter;
    const { tanstackStartCookies } = start;
    return betterAuth({
      baseURL: settings.origin,
      secret: settings.secret,
      database: drizzleAdapter(database, { provider: "pg", schema }),
      session: { deferSessionRefresh: true },
      databaseHooks: {
        user: {
          create: {
            after: async ({ id }) => {
              try {
                await created.run({ input: { accountId: id } });
              } catch (error) {
                log.error("auth.accountStreamFailed", { accountId: id, error: String(error) });
              }
            },
          },
        },
        session: {
          create: {
            after: ({ userId }) => created.run({ input: { accountId: userId } }),
          },
          delete: {
            after: ({ userId }) => deleted.run({ rawInput: { accountId: userId } }),
          },
        },
      },
      emailAndPassword: {
        enabled: true,
        sendResetPassword: async ({ user, url }) =>
          send.enqueue({ to: user.email, subject: "Reset your password", text: url }),
      },
      emailVerification: {
        sendOnSignUp: true,
        sendVerificationEmail: async ({ user, url }) =>
          send.enqueue({ to: user.email, subject: "Check your email", text: url }),
      },
      plugins: [tanstackStartCookies()],
    });
  },
});

export const principal = resource({
  label: "request.principal",
  target: "session",
  depends: { auth, headers: requestHeaders },
  factory: async ({ auth, headers }) =>
    (
      await auth.api.getSession({
        headers,
        query: { disableCookieCache: true, disableRefresh: true },
      })
    )?.user ?? null,
});

/** A long stream rechecks the live cookie without using caches or refreshing the session. */
export const liveAccount = operation({
  label: "sync.liveAccount",
  depends: { auth, headers: requestHeaders },
  run: async ({ auth, headers }) =>
    (
      await auth.api.getSession({
        headers,
        query: { disableCookieCache: true, disableRefresh: true },
      })
    )?.user.id ?? null,
});
