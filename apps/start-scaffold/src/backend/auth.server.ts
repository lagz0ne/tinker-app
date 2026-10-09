import { operation, resource } from "@tinker/core";
import { database } from "./database.server";
import { authMail } from "./mail.server";
import { authSettings, requestHeaders } from "@tinker/start/server";

export { authSettings } from "@tinker/start/server";
import { raise } from "../errors";
import * as schema from "./schema.server";
import { betterAuthModule, betterAuthDrizzle, betterAuthStart } from "./modules";

/** The root tracks each mail action; auth callbacks return before delivery. */
export const auth = resource({
  label: "auth",
  depends: {
    database,
    settings: authSettings,
    send: authMail,
    auth: betterAuthModule,
    adapter: betterAuthDrizzle,
    start: betterAuthStart,
  },
  factory: async ({ database, settings, send, auth, adapter, start }) => {
    const { betterAuth } = auth;
    const { drizzleAdapter } = adapter;
    const { tanstackStartCookies } = start;
    return betterAuth({
      baseURL: settings.origin,
      secret: settings.secret,
      database: drizzleAdapter(database, { provider: "pg", schema }),
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
