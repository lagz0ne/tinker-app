import { operation } from "@tinker/core";
import { z } from "zod";
import { auth } from "#tinker/app.server";

/**
 * ADR 0103's named protocol exception: the app's auth library owns its HTTP contract, so this
 * operation hands it the whole request and returns its reply as is.
 */
export const handleAuth = operation({
  label: "handleAuth",
  input: z.instanceof(Request),
  depends: { auth },
  run: async ({ auth }, { input }) => auth.handler(input),
});
