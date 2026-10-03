import { test, expect } from "vite-plus/test";
import { createScope } from "@tinker/core";
import { pageEvents, tabLifetime } from "@tinker-start-scaffold/sync";
/** A page hide event; `persisted` true means the tab went into the back-forward cache. */
const hide = (persisted: boolean) => Object.assign(new Event("pagehide"), { persisted });

test("binding after the factory ends closes the tab once on a real page hide", async () => {
  const page = new EventTarget();
  const stop = new AbortController();
  const scope = createScope({ signal: stop.signal, tags: pageEvents(page) });
  await scope.ready;
  let closes = 0;
  expect(() =>
    scope.resolve(tabLifetime).bind(async () => {
      closes += 1;
    }),
  ).not.toThrow();
  page.dispatchEvent(hide(true));
  expect(closes).toBe(0);
  page.dispatchEvent(hide(false));
  expect(closes).toBe(1);
  stop.abort();
  expect((await scope.closed).status).toBe("success");
  page.dispatchEvent(hide(false));
  expect(closes).toBe(1);
});

test("the server side has no page and binds without listening", async () => {
  const stop = new AbortController();
  const scope = createScope({ signal: stop.signal });
  await scope.ready;
  expect(() => scope.resolve(tabLifetime).bind(async () => undefined)).not.toThrow();
  stop.abort();
  expect((await scope.closed).status).toBe("success");
});
