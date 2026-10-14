import { resource } from "@tinker/core";

import { database } from "~/components/database/index.server";
import { requestHeaders } from "~/components/requests/index.server";

import { betterAuthModule, betterAuthDrizzle, betterAuthStart } from "./modules";
import * as schema from "./schema.server";
import { authSettings } from "./settings.server";
import { sendAuthMail, sessionDeleted } from "./slots";

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
    send: sendAuthMail.required,
    deleted: sessionDeleted.required,
    auth: betterAuthModule,
    adapter: betterAuthDrizzle,
    start: betterAuthStart,
  },
  factory: async ({ database, settings, send, deleted, auth, adapter, start }) => {
    const { betterAuth } = auth;
    const { drizzleAdapter } = adapter;
    const { tanstackStartCookies } = start;
    return betterAuth({
      baseURL: settings.origin,
      secret: settings.secret,
      database: drizzleAdapter(database, { provider: "pg", schema }),
      databaseHooks: {
        session: {
          delete: {
            after: ({ userId }) => deleted(userId),
          },
        },
      },
      emailAndPassword: {
        enabled: true,
        sendResetPassword: async ({ user, url }) => {
          send({ to: user.email, subject: "Reset your password", text: url });
        },
      },
      emailVerification: {
        sendOnSignUp: true,
        sendVerificationEmail: async ({ user, url }) => {
          send({ to: user.email, subject: "Check your email", text: url });
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
