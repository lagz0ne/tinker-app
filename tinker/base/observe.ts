import { tag } from "@tinker/core";
import type { Observe } from "@tinker/core";

/** The command binds render observation; each request borrows it from its own app root. */
export const renderObservation = tag<Observe.Config | undefined>({
  label: "start.renderObservation",
  default: undefined,
});
