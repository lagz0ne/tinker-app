import { createSse as createClient } from "~/components/sse";
import { createSse as createServer } from "~/components/sse/index.server";

/** Both sides of one SSE transport, as a test wires them: the client and the server. */
export const createSse = () => ({ ...createClient(), ...createServer() });

/** The default client and server, as `cmds/browser.tsx` and `cmds/server.ts` import them. */
export { sse as sseClient } from "~/components/sse";
export { sse as sseServer } from "~/components/sse/index.server";
