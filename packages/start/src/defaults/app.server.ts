import type { Many, Scope } from "@tinker/core";

/** The base's empty server seam: an app with no src/lib/tinker.server.ts adds no extensions. */
export const extensions: Many<Scope.Extension<unknown>> = [];
