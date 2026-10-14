import type { Many, Scope } from "@tinker/core";

import type { RouterOptions } from "~/base/router-entry";

/** The base's empty router file: an app with no src/router.ts keeps the base's router options. */
export const router: RouterOptions = () => ({});

export const extensions: Many<Scope.Extension<unknown>> = [];
