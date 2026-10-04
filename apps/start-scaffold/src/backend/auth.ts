import { operation, resource, tag } from "@tinker/core";
import type { BetterAuthPlugin } from "better-auth";
import { database } from "./database.ts";
import { sendMail } from "./mail.ts";
import { requestHeaders } from "../scaffold/backend/headers.server.ts";
import { raise } from "../errors.ts";
export declare namespace Auth {
  type Settings = {
    origin: string | { allowedHosts: string[]; fallback: string };
    secret: string;
    plugins: BetterAuthPlugin[];
  };
}
export const authSettings = tag<Auth.Settings>({ label: "auth.settings" });
export const auth = resource({
  label: "auth",
  target: "session",
  depends: { database, settings: authSettings, send: sendMail },
  factory: async ({ database, settings, send }) => {
    const [{ betterAuth }, { drizzleAdapter }, schema] = await Promise.all([
      import("better-auth"),
      import("better-auth/adapters/drizzle"),
      import("./schema.ts"),
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
      plugins: settings.plugins,
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
