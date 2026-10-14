import { tag } from "@tinker/core";

/** The main supplies its host signal before graceful drain joins held requests. */
export const backendStop = tag<AbortSignal>({ label: "lifetime.backendStop" });

export const requestStop = tag<AbortSignal>({ label: "lifetime.requestStop" });
