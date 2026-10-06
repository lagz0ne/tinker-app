import { operation } from "@tinker/core";
import { version } from "../../package.json";
/** The base's own probe: the protocol layer turns its value into the health reply. */
export const health = operation({
  label: "tinker.health",
  run: () => ({ ok: true, base: version }),
});
