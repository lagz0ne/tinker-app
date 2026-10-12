import { authStartup, readAuthSettings } from "./settings";
import type { Auth } from "./settings";

/** The auth part, on, for the server entry: the entry fills its settings; the root checks them. */
export const auth: Auth.ServerPart = { extensions: [authStartup], settings: readAuthSettings };
