import { operation } from "@tinker/core";

/** The template version: the same as `version` in package.json (tests/health.test.ts checks it). */
export const baseVersion = "0.18.0";

export const health = operation({
  label: "tinker.health",
  run: () => ({ ok: true, base: baseVersion }),
});
