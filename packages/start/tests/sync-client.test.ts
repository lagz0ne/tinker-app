import { createScope, operation } from "@tinker/core";
import { makeTestClock } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";
import { applied, savedPrivate, savedPublic } from "#tinker/app";
import { accountOwner, tabLifetime } from "../src/parts/sync/client/owner.ts";
import {
  applyBootstrap,
  applyEvents,
  leaveAccount,
  syncClient,
} from "../src/parts/sync/client/sync.ts";
import { pageEvents, tabStop } from "../src/parts/sync/client/tab.ts";
import type { Sync } from "../src/parts/sync/envelopes.ts";

/** A page hide event; `persisted` true means the tab went into the back-forward cache. */
const hide = (persisted: boolean) => Object.assign(new Event("pagehide"), { persisted });
const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];
const ada: Sync.Snapshot = {
  public: { stream: "public", revision: 0 },
  private: { stream: "ada", revision: 0 },
};
const event = (stream: string, revision: number, change: unknown): Sync.Event => ({
  stream,
  revision,
  executionId: ids[0],
  payload: { kind: "change", change },
});
const result = (stream: string, revision: number, executionId: string): Sync.Event => ({
  stream,
  revision,
  executionId,
  payload: { kind: "result", result: { kind: "done" } },
});

test("binding after the factory ends closes the tab once on a real page hide", async () => {
  const page = new EventTarget();
  const root = createScope({ tags: pageEvents(page) });
  let closes = 0;
  root.resolve(tabLifetime).bind(async () => {
    closes += 1;
  });
  page.dispatchEvent(hide(true));
  expect(closes).toBe(0);
  page.dispatchEvent(new Event("pagehide"));
  page.dispatchEvent(hide(false));
  expect(closes).toBe(2);
  expect((await root.close({ graceful: true })).status).toBe("success");
  page.dispatchEvent(hide(false));
  expect(closes).toBe(2);
});

test("the server side has no page and binds without listening", async () => {
  const root = createScope();
  expect(() => root.resolve(tabLifetime).bind(async () => undefined)).not.toThrow();
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the account owner versions each account and stops its work; the tab stop stops it too", async () => {
  const tab = new AbortController();
  const root = createScope({ extensions: [accountOwner], tags: tabStop(tab.signal) });
  await root.ready;
  const owner = root.resolve(accountOwner);
  const first = owner.capture();
  expect([first.version, first.signal.aborted]).toEqual([0, false]);
  owner.reset();
  const second = owner.capture();
  expect([first.signal.aborted, second.version, second.signal.aborted]).toEqual([true, 1, false]);
  tab.abort();
  expect(second.signal.aborted).toBe(true);
  owner.reset();
  expect(owner.capture()).toMatchObject({ version: 2, signal: { aborted: true } });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("closing the root stops the account's work", async () => {
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  const { signal } = root.resolve(accountOwner).capture();
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(signal.aborted).toBe(true);
});

test("a snapshot sets the records and cursors once; a stale version or an older snapshot is ignored", async () => {
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  const client = await root.resolve(syncClient);
  expect(client.cursors()).toEqual({ accountId: null, publicRevision: -1, privateRevision: -1 });
  const first = {
    public: { stream: "public" as const, revision: 2 },
    private: { stream: "ada", revision: 3 },
  };
  expect(await root.run(applyBootstrap, { input: { snapshot: first, version: 0 } })).toBe(1);
  expect(client.cursors()).toEqual({ accountId: "ada", publicRevision: 2, privateRevision: 3 });
  expect([root.resolve(savedPublic), root.resolve(savedPrivate)]).toEqual([
    first.public,
    first.private,
  ]);
  expect(await root.run(applyBootstrap, { input: { snapshot: ada, version: 1 } })).toBe(1);
  expect([root.resolve(savedPublic), root.resolve(savedPrivate)]).toEqual([
    first.public,
    first.private,
  ]);
  expect(client.cursors()).toEqual({ accountId: "ada", publicRevision: 2, privateRevision: 3 });
  expect(await root.run(applyBootstrap, { input: { snapshot: first, version: 7 } })).toBe(
    undefined,
  );
  expect(client.snapshot()).toEqual({
    public: { stream: "public", revision: 2 },
    private: { stream: "ada", revision: 3 },
  });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("events apply in order: a repeat is skipped, a gap stops the batch, an unknown stream is skipped", async () => {
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const client = await root.resolve(syncClient);
  await root.run(applyEvents, {
    input: {
      version: 1,
      events: [
        event("public", 1, "p1"),
        event("public", 1, "again"),
        event("grace", 1, "not mine"),
        event("ada", 1, "a1"),
        event("ada", 3, "gap"),
        event("ada", 2, "after the gap"),
      ],
    },
  });
  expect(root.resolve(applied)).toEqual(["p1", "a1"]);
  expect(client.cursors()).toEqual({ accountId: "ada", publicRevision: 1, privateRevision: 1 });
  await root.run(applyEvents, { input: { version: 3, events: [event("public", 2, "stale")] } });
  expect(root.resolve(applied)).toEqual(["p1", "a1"]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("an event before its receipt finishes the write only after the receipt, with its result", async () => {
  const receipt = Promise.withResolvers<Sync.Reply>();
  const sent = Promise.withResolvers<void>();
  const send = operation({
    label: "test.sync.send",
    depends: { sync: syncClient },
    run: async ({ sync }, { signal }) =>
      sync.execute(
        ids[1],
        {
          data: "save",
          send: ({ data }) => {
            expect(data).toBe("save");
            sent.resolve();
            return receipt.promise;
          },
        },
        signal,
      ),
  });
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const waiting = root.run(send);
  await sent.promise;
  await root.run(applyEvents, {
    input: { version: 1, events: [event("public", 1, "saved"), result("public", 2, ids[1])] },
  });
  expect(root.resolve(applied)).toEqual(["saved"]);
  receipt.resolve({ kind: "accepted", executionId: ids[1] });
  expect(await waiting).toEqual({ kind: "done" });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a receipt before its event waits for the result event", async () => {
  const sent = Promise.withResolvers<void>();
  const send = operation({
    label: "test.sync.send",
    depends: { sync: syncClient },
    run: async ({ sync }, { signal }) =>
      sync.execute(
        ids[1],
        {
          data: undefined,
          send: async () => {
            sent.resolve();
            return { kind: "accepted", executionId: ids[1] };
          },
        },
        signal,
      ),
  });
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const waiting = root.run(send);
  await sent.promise;
  await root.run(applyEvents, { input: { version: 1, events: [result("ada", 1, ids[1])] } });
  expect(await waiting).toEqual({ kind: "done" });
  await root.run(applyEvents, { input: { version: 1, events: [result("ada", 2, ids[2])] } });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a rejected write fails with its message; a send that throws is retried after 500 ms", async () => {
  const clock = makeTestClock();
  const tries: string[] = [];
  const arrived = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const send = operation({
    label: "test.sync.retry",
    depends: { sync: syncClient },
    run: async ({ sync }, { signal }) =>
      sync.execute(
        ids[1],
        {
          data: undefined,
          send: async () => {
            arrived[tries.length]?.resolve();
            tries.push("sent");
            if (tries.length === 1) throw new TypeError("offline");
            return { kind: "rejected", message: "name taken" };
          },
        },
        signal,
      ),
  });
  const logs: string[] = [];
  const root = createScope({
    clock,
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
    observe: { log: ({ message }) => logs.push(message) },
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const writing = root.settle(send);
  await arrived[0]?.promise;
  expect(tries).toEqual(["sent"]);
  await Promise.resolve();
  clock.advance(499);
  expect(tries).toEqual(["sent"]);
  clock.advance(1);
  await arrived[1]?.promise;
  expect(await writing).toMatchObject({
    status: "failed",
    error: { kind: "WriteRejected", payload: { message: "name taken" } },
  });
  expect(logs).toEqual(["sync.reconnecting"]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("an account exit stops local waits and ignores the old account's late events", async () => {
  const sent = Promise.withResolvers<void>();
  const send = operation({
    label: "test.sync.send",
    depends: { sync: syncClient },
    run: async ({ sync }, { signal }) =>
      sync.execute(
        ids[1],
        {
          data: undefined,
          send: async () => {
            sent.resolve();
            return { kind: "accepted", executionId: ids[1] };
          },
        },
        signal,
      ),
  });
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const client = await root.resolve(syncClient);
  const waiting = root.settle(send);
  await sent.promise;
  await root.run(leaveAccount);
  expect(await waiting).toMatchObject({ status: "failed", error: { kind: "Cancelled" } });
  expect([root.resolve(savedPrivate), client.cursors()]).toEqual([
    null,
    { accountId: null, publicRevision: 0, privateRevision: -1 },
  ]);
  const grace = { ...ada, private: { stream: "grace", revision: 0 } };
  await root.run(applyBootstrap, { input: { snapshot: grace, version: 2 } });
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 1 } });
  await root.run(applyEvents, { input: { version: 1, events: [event("ada", 1, "late")] } });
  expect([root.resolve(savedPrivate), root.resolve(applied)]).toEqual([grace.private, []]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a snapshot for another account while a write is pending leaves the account, and waits", async () => {
  const sent = Promise.withResolvers<void>();
  const hold = Promise.withResolvers<Sync.Reply>();
  const send = operation({
    label: "test.sync.held",
    depends: { sync: syncClient },
    run: async ({ sync }, { signal }) =>
      sync.execute(
        ids[1],
        {
          data: undefined,
          send: () => {
            sent.resolve();
            return hold.promise;
          },
        },
        signal,
      ),
  });
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const client = await root.resolve(syncClient);
  const writing = root.settle(send);
  await sent.promise;
  const grace = { ...ada, private: { stream: "grace", revision: 0 } };
  expect(await root.run(applyBootstrap, { input: { snapshot: ada, version: 1 } })).toBe(undefined);
  expect(client.capture().version).toBe(1);
  expect(await root.run(applyBootstrap, { input: { snapshot: grace, version: 1 } })).toBe(2);
  hold.resolve({ kind: "accepted", executionId: ids[1] });
  expect(await writing).toMatchObject({ status: "failed", error: { kind: "Cancelled" } });
  expect(root.resolve(savedPrivate)).toEqual(grace.private);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("closing the root cancels a write that waits for its result", async () => {
  const sent = Promise.withResolvers<void>();
  const send = operation({
    label: "test.sync.send",
    depends: { sync: syncClient },
    run: async ({ sync }, { signal }) =>
      sync.execute(
        ids[1],
        {
          data: undefined,
          send: async () => {
            sent.resolve();
            return { kind: "accepted", executionId: ids[1] };
          },
        },
        signal,
      ),
  });
  const tab = new AbortController();
  const root = createScope({ extensions: [accountOwner], tags: tabStop(tab.signal) });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const writing = root.settle(send);
  await sent.promise;
  tab.abort();
  expect(await writing).toMatchObject({ status: "failed", error: { kind: "Cancelled" } });
  expect((await root.close({ graceful: true })).status).toBe("success");
});
