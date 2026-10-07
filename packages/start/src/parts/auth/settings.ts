import { extension, resource } from "@tinker/core";
import type { Many, Scope } from "@tinker/core";
import { readPartEnv } from "../../../lib/part-env.mjs";
import basePackage from "../../../package.json" with { type: "json" };
import { env } from "../../env.ts";
import { raise } from "../../errors.ts";

export declare namespace Auth {
  /** What the app's `auth` resource builds on: the public origin and the signing secret. */
  type Settings = { origin: string; secret: string };
  /** What the auth part gives the server entry (ADR 0106): extensions for the app root. */
  type ServerPart = { readonly extensions: Many<Scope.Extension<unknown>> };
}

/**
 * The auth part's own env keys, read once and checked (ADR 0106). Neither has a default:
 * a secret must never fall back, and the origin is where the app is served.
 */
export const authSettings = resource({
  label: "auth.settings",
  depends: { env },
  factory: ({ env }): Auth.Settings => {
    const { values, refused } = readPartEnv(basePackage.tinker.parts.auth.env, env);
    if (refused.length > 0) raise("BadSettings", { part: "auth", keys: refused });
    return { origin: values.PUBLIC_ORIGIN, secret: values.AUTH_SECRET };
  },
});

/** On the app root: it does not start while an auth key is unset or refused. */
export const authStartup = extension({
  label: "auth",
  hooks: {
    async start({ resolve, next }) {
      resolve(authSettings);
      await next();
    },
  },
});
