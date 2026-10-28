import { tag } from "@tinker/core";

/** The tab's stop signal: the router entry binds the one that closes its app root. */
export const tabStop = tag<AbortSignal>({ label: "sync.tabStop" });
