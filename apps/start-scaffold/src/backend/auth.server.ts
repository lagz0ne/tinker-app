import { operation, resource } from "@tinker/core";
import { database } from "./database.server";
import { authMail } from "./mail.server";
import { accountNotice, authSettings, drizzleOrm, requestHeaders } from "@tinker/start/server";

export { authSettings } from "@tinker/start/server";
import { raise } from "../errors";
import * as schema from "./schema.server";
import { betterAuthModule, betterAuthDrizzle, betterAuthStart } from "./modules";

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
    auth: betterAuthModule,
    adapter: betterAuthDrizzle,
    start: betterAuthStart,
    orm: drizzleOrm,
  },
  factory: async ({ database, settings, send, auth, adapter, start, orm }) => {
    const { betterAuth } = auth;
    const { drizzleAdapter } = adapter;
    const { tanstackStartCookies } = start;
    const { sql } = orm;
    return betterAuth({
      baseURL: settings.origin,
      secret: settings.secret,
      database: drizzleAdapter(database, { provider: "pg", schema }),
      databaseHooks: {
        session: {
          delete: {
            after: async ({ userId }) => {
              await database.execute(sql`select pg_notify('start_sync', ${accountNotice(userId)})`);
            },
          },
        },
      },
      emailAndPassword: {
        enabled: true,
        sendResetPassword: async ({ user, url }) => {
          send.enqueue({ to: user.email, subject: "Reset your password", text: url });
        },
      },
      emailVerification: {
        sendOnSignUp: true,
        sendVerificationEmail: async ({ user, url }) => {
          send.enqueue({ to: user.email, subject: "Check your email", text: url });
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

export const currentUser = resource({
  label: "request.currentUser",
  target: "session",
  depends: { principal },
  factory: async ({ principal }) => {
    if (principal === null) raise("SignInRequired", {});
    return principal;
  },
});

export const readAccount = operation({
  label: "readAccount",
  depends: { principal },
  run: async ({ principal }) => principal?.id ?? null,
});
