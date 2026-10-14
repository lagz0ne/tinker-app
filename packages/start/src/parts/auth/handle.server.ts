import { operation } from "@tinker/core";
import { z } from "zod";

import { startRequests } from "~/components/requests/index";

import { serverParts } from "../../server-parts";

/**
 * ADR 0103's named protocol exception: the app's auth library owns its HTTP contract, so this
 * operation hands it the whole request and returns its reply as is.
 */
export const handleAuth = operation({
  label: "handleAuth",
  input: z.instanceof(Request),
  depends: { parts: serverParts, requests: startRequests },
  run: async ({ parts, requests }, { input }) =>
    (await requests.scope.resolve(parts.auth)).handler(input),
});
