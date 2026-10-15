import { createScope, type Scope } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { liveAccount } from "~/components/auth/index.server";
import { backendStop, requestStop, startRequests } from "~/components/requests";
import { requestHeaders } from "~/components/requests/index.server";
import { notifications } from "~/components/sync/notifications.server";
import { openSync } from "~/components/sync/stream.server";

import { bindings, proofServices } from "./fixtures/app.server";
import { handWoken } from "./fixtures/sync";

for (const stopped of [false, true]) {
  test(`an account recheck that rejects ${stopped ? "after request abort closes cleanly" : "errors the body and removes its wait"}`, async () => {
    const clock = makeTestClock();
    const hand = handWoken();
    const stop = new AbortController();
    const checked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string | null>();
    const error = new Error("account unavailable");
    let reads = 0;
    const root = createScope({
      clock,
      extensions: [startRequests],
      tags: [
        bindings,
        backendStop(stop.signal),
        requestStop(stop.signal),
        requestHeaders(new Headers()),
      ],
      presets: [
        ...proofServices((): Scope.Handle => root),
        hand.db,
        preset(liveAccount, async () => {
          reads++;
          if (reads === 1) return "Ada";
          checked.resolve();
          return release.promise;
        }),
      ],
    });

    await root.ready;
    const session = root.createSession();
    const body = await session.run(openSync, {
      input: { cursor: { public: 0, private: { accountId: "Ada", revision: 0 } } },
    });
    const reader = body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
    const pending = reader.read();
    hand.notice("Ada");
    await checked.promise;
    if (stopped) stop.abort();
    release.reject(error);
    if (stopped) expect(await pending).toEqual({ value: undefined, done: true });
    else await expect(pending).rejects.toBe(error);
    expect(reads).toBe(2);
    expect((await root.resolve(notifications)).revision()).toBe(0);
    await session.close({ graceful: true });
    expect((await root.close({ graceful: true })).teardownErrors).toBeUndefined();
  });
}

test("a stream cancelled before its first pull reads no rows and leaves the next stream usable", async () => {
  const queries: string[] = [];
  const hand = handWoken((query) => queries.push(query));
  const stop = new AbortController();
  const root = createScope({
    extensions: [startRequests],
    tags: [
      bindings,
      backendStop(stop.signal),
      requestStop(stop.signal),
      requestHeaders(new Headers()),
    ],
    presets: [...proofServices((): Scope.Handle => root), hand.db],
  });

  await root.ready;
  const first = root.createSession();
  const body = await first.run(openSync, { input: { cursor: { public: 0, private: null } } });
  expect(queries.filter((query) => query.includes('from "sync_event"'))).toEqual([]);
  await body.cancel();
  expect((await first.close({ graceful: true })).status).toBe("success");
  const next = root.createSession();
  const reader = (
    await next.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
  expect(queries.filter((query) => query.includes('from "sync_event"'))).toHaveLength(1);
  await reader.cancel();
  expect((await next.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});
