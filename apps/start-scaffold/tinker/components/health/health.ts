import { operation } from "@tinker/core";

/** The copied base version; it changes when this component is updated. */
export const baseVersion = "0.11.0";

export const health = operation({
  label: "tinker.health",
  run: () => ({ ok: true, base: baseVersion }),
});
