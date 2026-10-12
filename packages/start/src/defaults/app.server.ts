import type { Many, Scope } from "@tinker/core";

import type { Env } from "../env";

/** The base's empty server seam: an app with no src/lib/tinker.server.ts adds no extensions. */
export const extensions: Many<Scope.Extension<unknown>> = [];

/** The base's empty settings: the app fills no settings tags. */
export const settings: Env.Read = () => [];
