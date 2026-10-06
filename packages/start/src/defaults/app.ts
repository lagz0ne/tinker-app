import type { Many, Scope } from "@tinker/core";
/** The base's empty client seam: an app with no src/lib/tinker.ts adds no extensions. */
export const extensions: Many<Scope.Extension<unknown>> = [];
