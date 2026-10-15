import { resource } from "@tinker/core";

import { abortReasons } from "~/components/errors";
import { tabStop } from "~/components/sync/client/tab";

/**
 * Who the tab's work belongs to: a version that changes on each account exit, and a signal that
 * stops that account's work. The tab stop signal stops it too, before Core's graceful shutdown
 * waits for it.
 */
export const accountOwner = resource({
  label: "sync.accountOwner",
  depends: { signal: tabStop },
  factory: ({ signal }, { defer }) => {
    let stop = new AbortController();
    let version = 0;

    const cancel = () => stop.abort(abortReasons.closed);
    signal.addEventListener("abort", cancel, { once: true });

    defer(() => {
      signal.removeEventListener("abort", cancel);
      stop.abort(abortReasons.closed);
    });

    return {
      capture: () => ({ version, signal: stop.signal }),
      version: () => version,
      reset: () => {
        stop.abort(abortReasons.changed);
        stop = new AbortController();
        version += 1;
        if (signal.aborted) stop.abort(abortReasons.closed);
      },
    };
  },
});
