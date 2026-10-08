import { tag } from "@tinker/core";

/** Original host signals end HTTP, telemetry bodies, and sync before graceful Core shutdown joins requests. */
export const backendStop = tag<AbortSignal>({ label: "lifetime.backendStop" });
export const requestStop = tag<AbortSignal>({ label: "lifetime.requestStop" });
