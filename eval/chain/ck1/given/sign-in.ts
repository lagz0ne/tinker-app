import { data, operation } from "@tinkered/core";
import { z } from "zod";

// The tab's sign-in stand-in: a name, sent as `who` in each message's meta. No password: the
// board shows keyed parts and their guard, not an auth flow. A real app sends a token here.

/** Who this tab is; empty until it signs in. */
export const me = data({ label: "issues.me", initial: "" });

export const signIn = operation({
  label: "issues.signIn",
  input: z.object({ name: z.string().trim().min(1) }),
  depends: { who: me.controller },
  run: ({ who }, { input }) => who.set(input.name),
});

/** The transport's `meta`: each call and each ask carries `who`. */
export const whoMeta = operation({
  label: "issues.whoMeta",
  depends: { who: me },
  run: async ({ who }): Promise<Record<string, string>> => (who ? { who } : {}),
});
