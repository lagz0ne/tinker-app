import type { App } from "./app";

/** Each reader has already run once; requires lists all prior dependency paths. */
export declare function joinSettings(
  items: {
    file: string;
    requires: readonly string[];
    bindings: App.Bindings;
  }[],
): App.Bindings;
