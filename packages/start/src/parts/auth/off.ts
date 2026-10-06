import type { Auth } from "./settings.ts";

/** The auth part, off: nothing on the app root, and `/api/auth/$` is the app's. */
export const auth: Auth.ServerPart = { extensions: [] };
