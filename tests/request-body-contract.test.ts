import { getEventListeners } from "node:events";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { backendStop, requestStop } from "~/components/requests/lifetime";
import { requestBody } from "~/components/requests/request-body.server";

for (const stopAt of ["before-open", "reading", "none"] as const) {
  test(`request body ${stopAt} owns cancellation and unlocks only after it joins`, async () => {
    const backend = new AbortController();
    const stop = new AbortController();
    const finish = Promise.withResolvers<void>();
    let cancelled = 0;
    const root = createScope({ tags: [backendStop(backend.signal), requestStop(stop.signal)] });
    const session = root.createSession();
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      cancel: async () => {
        cancelled++;
        await finish.promise;
      },
    });

    try {
      const owned = session.resolve(requestBody);

      expect(getEventListeners(owned.signal, "abort")).toHaveLength(1);
      if (stopAt === "before-open") stop.abort();
      owned.open(body);
      expect(body.locked).toBe(true);
      if (stopAt === "reading") backend.abort();
      expect(cancelled).toBe(stopAt === "none" ? 0 : 1);
      let done = false;
      const release = owned.release().then(() => {
        done = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (stopAt !== "none") {
        expect(done).toBe(false);
        expect(body.locked).toBe(true);
      }
      finish.resolve();
      await release;
      expect(body.locked).toBe(false);
      expect(getEventListeners(owned.signal, "abort")).toEqual([]);
      await session.close({ graceful: true });
      expect(cancelled).toBe(stopAt === "none" ? 0 : 1);
    } finally {
      finish.resolve();
      await session.close();
      await root.close();
    }
  });
}

test("closing a request session releases its unused body resource", async () => {
  const root = createScope({
    tags: [backendStop(new AbortController().signal), requestStop(new AbortController().signal)],
  });
  const session = root.createSession();
  try {
    const owned = session.resolve(requestBody);
    expect(getEventListeners(owned.signal, "abort")).toHaveLength(1);
    await session.close({ graceful: true });
    expect(getEventListeners(owned.signal, "abort")).toEqual([]);
  } finally {
    await session.close();
    await root.close();
  }
});
