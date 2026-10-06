import { authStartup } from "./settings.ts";
import type { Auth } from "./settings.ts";

/** The auth part, on, for the server entry: the app root checks the auth keys at start. */
export const auth: Auth.ServerPart = { extensions: [authStartup] };
