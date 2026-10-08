import { tag } from "@tinker/core";

/** The tab's stop signal: the router entry binds the one that closes its app root. */
export const tabStop = tag<AbortSignal>({ label: "sync.tabStop" });

/** The browser entry passes `window`; the server passes nothing. */
export const pageEvents = tag<EventTarget | undefined>({
  label: "sync.pageEvents",
  default: undefined,
});
