import { operation } from "@tinker/core";
import { z } from "zod";

import type { Errors } from "~/components/errors";

/**
 * The greet contract: its label, its input, and its reply type. Tab and server import it.
 * It has no body of its own: the server's `rpc` runs its provider, the tab's sends it there.
 * Its reply is a promise: over the wire it always is, so the server's provider is async too.
 */
export const greet = operation({
  label: "greet",
  input: z.object({ name: z.string().min(1) }),
  run: async (_deps, { raise: coreRaise }): Promise<{ text: string }> => {
    const raise: Errors.Raise = coreRaise;

    return raise("RpcNoProvider", { label: "greet" });
  },
});
