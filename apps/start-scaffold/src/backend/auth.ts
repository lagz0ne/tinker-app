import { operation, resource } from "@tinker/core";
import { database } from "./database";
import { sendMail } from "./mail";
import { authSettings, requestHeaders } from "@tinker/start/server";
export { authSettings } from "@tinker/start/server";
import { raise } from "../errors";
export const auth = resource({
  label: "auth",
  depends: { database, settings: authSettings, send: sendMail },
  factory: async ({ database, settings, send }) => {
    const [{ betterAuth }, { drizzleAdapter }, { tanstackStartCookies }, schema] =
      await Promise.all([
        import("better-auth"),
        import("better-auth/adapters/drizzle"),
        import("better-auth/tanstack-start"),
        import("./schema"),
      ]);
    return betterAuth({
      baseURL: settings.origin,
      secret: settings.secret,
      database: drizzleAdapter(database, { provider: "pg", schema }),
      emailAndPassword: {
        enabled: true,
        sendResetPassword: async ({ user, url }) => {
          await send.run({ input: { to: user.email, subject: "Reset your password", text: url } });
        },
      },
      emailVerification: {
        sendOnSignUp: true,
        sendVerificationEmail: async ({ user, url }) => {
          await send.run({ input: { to: user.email, subject: "Check your email", text: url } });
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
