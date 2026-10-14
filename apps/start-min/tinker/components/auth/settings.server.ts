import { extension, isError, tag } from "@tinker/core";
import { z } from "zod";

import { raise } from "~/components/errors";
import type { Env } from "~/components/errors";

import { sendAuthMail, sessionDeleted } from "./slots";

export declare namespace Auth {
  type Settings = { origin: string; secret: string };
  type ServerPart = {
    readonly extensions: readonly (typeof authStartup)[];
    readonly settings: Env.Read;
  };
}

export const authSettings = tag<Auth.Settings>({ label: "auth.settings" });

const authEnv = z.object({
  PUBLIC_ORIGIN: z.url({ protocol: /^https?$/ }),
  AUTH_SECRET: z.string().min(32),
});

/**
 * @param env - From the command's copy of process.env; why: check auth's two keys once.
 */
export function settings(env: Env.Values) {
  const parsed = authEnv.safeParse(env);
  if (!parsed.success) {
    raise("BadSettings", {
      part: "auth",
      keys: parsed.error.issues.map((issue) => String(issue.path[0])),
    });
  }

  return authSettings({ origin: parsed.data.PUBLIC_ORIGIN, secret: parsed.data.AUTH_SECRET });
}

/** Missing hooks fail before a database or auth client starts. */
export const authStartup = extension({
  label: "auth",
  hooks: {
    async start({ resolve, next }) {
      resolve(authSettings);
      try {
        resolve(sendAuthMail);
        resolve(sessionDeleted);
      } catch (error) {
        if (isError(error, "MissingTag")) {
          error.message = `Auth startup needs "${error.payload.label}" in cmds/server.ts`;
        }
        throw error;
      }

      await next();
    },
  },
});
