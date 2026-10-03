import { extension, resource, tag } from "@tinker/core";
export const tabStop = tag<AbortSignal>({ label: "sync.tabStop" });
/** The browser entry passes `window`; the server passes nothing. */
export const pageEvents = tag<EventTarget | undefined>({
  label: "sync.pageEvents",
  default: undefined,
});
/** Listens while the factory runs; `bind` only names what to close. */
export const tabLifetime = resource({
  label: "router.tabLifetime",
  depends: { target: pageEvents },
  factory: ({ target }, ctx) => {
    let close: (() => Promise<void>) | undefined;
    const leave = (event: Event) => {
      if (!(event as PageTransitionEvent).persisted) return close?.();
    };
    target?.addEventListener("pagehide", leave);
    ctx.defer(() => target?.removeEventListener("pagehide", leave));
    return {
      bind: (next: () => Promise<void>) => {
        close = next;
      },
    };
  },
});
/** The entry signal stops active work before Core's graceful root shutdown waits for it. */
export const accountOwner = extension({
  label: "sync.accountOwner",
  hooks: {
    async start(event) {
      await event.next();
      const signal = event.scope.resolve(tabStop);
      let stop = new AbortController();
      let version = 0;
      const cancel = () => stop.abort();
      signal.addEventListener("abort", cancel, { once: true });
      event.defer(() => {
        signal.removeEventListener("abort", cancel);
        stop.abort();
      });
      return {
        capture: () => ({ version, signal: stop.signal }),
        reset: () => {
          stop.abort();
          stop = new AbortController();
          version += 1;
          if (signal.aborted) stop.abort();
        },
      };
    },
  },
});
