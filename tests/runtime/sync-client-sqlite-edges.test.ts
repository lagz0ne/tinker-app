import { getEventListeners } from "node:events";

import { createScope, operation } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { applyBootstrap, applyEvents, syncClient } from "~/components/sync-sqlite/client/sync";
import { tabStop } from "~/components/sync-sqlite/client/tab";
import type { Sync } from "~/components/sync-sqlite/envelopes";
import { bootstrapSlot, readAccountSlot } from "~/components/sync-sqlite/index.server";
import { syncSide, syncStartup } from "~/components/sync-sqlite/slots";

import { applied, clientBindings, savedPublic } from "./fixtures/app-sqlite";

const executionId = "00000000-0000-4000-8000-000000000001";

const ada: Sync.Snapshot = {
  public: { stream: "public", revision: 0 },
  private: { stream: "ada", revision: 0 },
};

/** A tab scope with the SQLite sync copy's slots bound and its records loaded. */
async function tab() {
  const root = createScope({
    extensions: [syncStartup],
    tags: [clientBindings, tabStop(new AbortController().signal)],
  });

  await root.ready;

  return root;
}

test("raw bootstrap and batch bodies go through the app's readers", async () => {
  const root = await tab();

  root.run(applyBootstrap, {
    rawInput: { version: 0, snapshot: { ...ada, public: { stream: "public", revision: 3 } } },
  });

  expect(root.resolve(savedPublic)).toEqual({ stream: "public", revision: 3 });

  root.run(applyEvents, {
    rawInput: {
      version: 1,
      events: [
        { stream: "public", revision: 4, executionId, payload: { kind: "change", change: "p4" } },
      ],
    },
  });

  expect(root.resolve(applied)).toEqual(["p4"]);

  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a raw body the reader refuses fails with the operation's label", async () => {
  const root = await tab();

  for (const [step, label] of [
    [applyBootstrap, "sync.bootstrap"],
    [applyEvents, "sync.apply"],
  ] as const) {
    const settled = await root.settle(step, { rawInput: { version: "one" } });

    expect(settled).toMatchObject({
      status: "failed",
      error: { kind: "DataValidationFailed", payload: { label } },
    });
  }

  expect(root.resolve(applied)).toEqual([]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a server-side scope has no tab records, so the tab client refuses to start", async () => {
  const bootstrap = operation({
    label: "proof.sqliteBootstrap",
    run: () => ({ public: { stream: "public" as const, revision: 0 }, private: null }),
  });

  const readAccount = operation({ label: "proof.sqliteReadAccount", run: () => null });

  const root = createScope({
    extensions: [syncStartup],
    tags: [
      syncSide("server"),
      bootstrapSlot(bootstrap),
      readAccountSlot(readAccount),
      tabStop(new AbortController().signal),
    ],
  });

  await root.ready;

  expect(() => root.resolve(syncClient)).toThrow(
    expect.objectContaining({ kind: "StreamMissing" }),
  );

  await root.close({ graceful: true });
});

test("a finished write leaves no abort listener on the signal it sent with", async () => {
  const root = await tab();

  root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });

  let sentWith: AbortSignal | undefined;

  const send = operation({
    label: "test.sync.send",
    depends: { sync: syncClient },
    run: async ({ sync }, { signal }) =>
      sync.execute(
        executionId,
        {
          data: "save",
          send: async ({ signal }) => {
            sentWith = signal;

            return { kind: "accepted", executionId };
          },
        },
        signal,
      ),
  });

  const waiting = root.run(send);

  // The receipt came first, so the write now waits on its signal for the result event.
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(sentWith && getEventListeners(sentWith, "abort")).toHaveLength(1);

  root.run(applyEvents, {
    input: {
      version: 1,
      events: [
        {
          stream: "public",
          revision: 1,
          executionId,
          payload: { kind: "result", result: { kind: "done" } },
        },
      ],
    },
  });

  expect(await waiting).toEqual({ kind: "done" });
  expect(sentWith && getEventListeners(sentWith, "abort")).toHaveLength(0);

  expect((await root.close({ graceful: true })).status).toBe("success");
});
