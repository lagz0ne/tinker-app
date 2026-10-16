import { operation, resource } from "@tinker/core";

import { database } from "~/components/database/index.server";
import { requestHeaders } from "~/components/requests/index.server";

import { authCalls } from "./calls.server";
import { betterAuthModule, betterAuthDrizzle, betterAuthStart } from "./modules";
import * as schema from "./schema.server";
import { authSettings, authStartup } from "./settings.server";
import { sendAuthMail, sessionDeleted, userCreated } from "./slots";

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
    calls: authCalls,
    outside: authStartup,
    send: sendAuthMail.required,
    deleted: sessionDeleted.required,
    created: userCreated.required,
    auth: betterAuthModule,
    adapter: betterAuthDrizzle,
    start: betterAuthStart,
  },
  factory: async ({
    database,
    settings,
    calls,
    outside,
    send,
    deleted,
    created,
    auth,
    adapter,
    start,
  }) => {
    const { betterAuth } = auth;
    const { drizzleAdapter } = adapter;
    const { tanstackStartCookies } = start;
    return betterAuth({
      baseURL: settings.origin,
      secret: settings.secret,
      database: drizzleAdapter(database, { provider: "pg", schema }),
      databaseHooks: {
        user: {
          create: {
            after: async ({ id }) => {
              await calls.fire(created, id, outside);
            },
          },
        },
        session: {
          delete: {
            after: ({ userId }) => calls.fire(deleted, userId, outside),
          },
        },
      },
      emailAndPassword: {
        enabled: true,
        sendResetPassword: async ({ user, url }) => {
          calls.fire(send, { to: user.email, subject: "Reset your password", text: url }, outside);
        },
      },
      emailVerification: {
        sendOnSignUp: true,
        sendVerificationEmail: async ({ user, url }) => {
          calls.fire(send, { to: user.email, subject: "Check your email", text: url }, outside);
        },
      },
      plugins: [tanstackStartCookies()],
    });
  },
});

export const principal = resource({
  label: "request.principal",
  target: "session",
  depends: { auth, headers: requestHeaders },
  factory: async ({ auth, headers }) => (await auth.api.getSession({ headers }))?.user ?? null,
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
