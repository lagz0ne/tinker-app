import { operation } from "@tinker/core";
import { z } from "zod";
import { auth } from "@/lib/tinker.server";

/** ADR 0103's named protocol exception mounts better-auth's third-party HTTP handler. */
export const handleAuth = operation({
  label: "handleAuth",
  input: z.instanceof(Request),
  depends: { auth },
  run: async ({ auth }, ctx) => auth.handler(ctx.input),
});
