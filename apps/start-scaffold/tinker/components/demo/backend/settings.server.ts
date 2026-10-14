import type { Env } from "@tinker/start/server";
import { z } from "zod";

import { raise } from "~/components/demo/errors";

import { databaseUrl } from "./database.server";

const appEnv = z.object({
  DATABASE_URL: z.url(),
});

/**
 * The main validates database keys once; database units receive typed tags (ADR 0113).
 * @param env - From the app's server entry; why: the keys to check and convert.
 */
export function settings(env: Env.Values) {
  const parsed = appEnv.safeParse(env);
  if (!parsed.success) {
    raise("BadSettings", {
      part: "app",
      keys: parsed.error.issues.map((issue) => issue.path.join(".")),
    });
  }

  return [databaseUrl(new URL(parsed.data.DATABASE_URL))];
}
