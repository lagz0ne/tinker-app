import { rpc } from "@tinker/core";
import { z } from "zod";

/**
 * Every call the client can make, by address. Server and client install `api` from this one
 * definition: the server with `implement`, the client with `remote`. Others reach it as `greet.api`.
 */
export const greetApi = rpc({
  greet: { input: z.object({ name: z.string().min(1) }), output: z.object({ text: z.string() }) },
});
