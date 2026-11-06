import { z } from "zod";

import { rpc } from "~/components/rpc";

/**
 * Every call the client can make, by address. Server and client install `api` from this one
 * definition: the server with `implement`, the client with `remote`.
 */
export const api = rpc({
  greet: { input: z.object({ name: z.string().min(1) }), output: z.object({ text: z.string() }) },
});
