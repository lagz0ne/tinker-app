import { operation } from "@tinker/core";
import { z } from "zod";

/** The payload an auth path sends on the `start_sync` channel to name one account. */
export const accountNotice = operation({
  label: "sync.notice",
  input: z.string(),
  run: (_deps, { input }) => `account:${input}`,
});
