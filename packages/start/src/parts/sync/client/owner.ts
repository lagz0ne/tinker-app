import { abortReasons } from "../../../errors";
import { extension, resource } from "@tinker/core";
import { pageEvents, tabStop } from "./tab";

/** Listens while the factory runs; `bind` only names what to close on a real page hide. */
export const tabLifetime = resource({
  label: "router.tabLifetime",
  depends: { target: pageEvents },
  factory: ({ target }, { defer }) => {
    let close: (() => Promise<void>) | undefined;
    const leave = (event: Event) => {
      if (!("persisted" in event) || !event.persisted) return close?.();
    };
    target?.addEventListener("pagehide", leave);
    defer(() => target?.removeEventListener("pagehide", leave));
    return {
      bind: (next: () => Promise<void>) => {
        close = next;
      },
    };
  },
});

/**
 * Who the tab's work belongs to: a version that changes on each account exit, and a signal that
 * stops that account's work. The tab stop signal stops it too, before Core's graceful shutdown
 * waits for it.
 */
export const accountOwner = extension({
  label: "sync.accountOwner",
  hooks: {
    async start({ next, scope, defer }) {
      await next();
      const signal = scope.resolve(tabStop);
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
        reset: () => {
          stop.abort(abortReasons.changed);
          stop = new AbortController();
          version += 1;
          if (signal.aborted) stop.abort(abortReasons.closed);
        },
      };
    },
  },
});
