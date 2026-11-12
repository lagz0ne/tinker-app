import { tag, transport } from "@tinkered/core";

/** The main supplies its host signal before graceful drain joins held requests. */
export const backendStop = tag<AbortSignal>({ label: "lifetime.backendStop" });

/** Aborts when the request ends: Core's own tag, so every rpc transport binds the same one. */
export const requestStop = transport.requestStop;
