import { expect, test } from "vite-plus/test";
import { createScope, operation } from "@tinker/core";
import { drizzleOrm } from "@tinker/start/server";
import * as drizzle from "drizzle-orm";

const readOrm = operation({
  label: "test.readOrm",
  depends: { orm: drizzleOrm },
  run: async ({ orm }) => orm,
});

test("the shared Drizzle module has one load span across sessions", async () => {
  const stop = new AbortController();
  const root = createScope({ signal: stop.signal, observe: { history: 20 } });
  await root.ready;
  try {
    for (let index = 0; index < 2; index++) {
      const session = root.createSession();
      try {
        expect(await session.run(readOrm)).toBe(drizzle);
      } finally {
        await session.close({ graceful: true });
      }
    }
    expect(root.spans().filter(({ name }) => name === "module:drizzle-orm")).toHaveLength(1);
  } finally {
    await root.close({ graceful: true });
    await root.closed;
  }
});
