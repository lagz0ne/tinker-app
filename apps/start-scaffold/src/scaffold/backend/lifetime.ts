import { tag } from "@tinker/core";
/** Original host signals end streaming waits before graceful Core shutdown waits for requests. */
export const backendStop = tag<AbortSignal>({ label: "sync.backendStop" });
export const requestStop = tag<AbortSignal>({ label: "sync.requestStop" });
