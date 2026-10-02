import { extension, tag } from "@tinker/core";
export const tabStop = tag<AbortSignal>({ label: "sync.tabStop" });
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
