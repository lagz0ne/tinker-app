import { createScope, operation } from "@tinker/core";
import { makeTestClock } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";
import { applied, savedPrivate, savedPublic } from "#tinker/app";
import { applyBootstrap, applyEvents, leaveAccount, syncClient } from "@tinker/start/client";
import { accountOwner, tabLifetime, pageEvents, tabStop } from "@tinker/start/testing";
import type { Sync } from "@tinker/start";

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
  const client = root.resolve(syncClient);
  expect(client.cursors()).toEqual({ accountId: null, publicRevision: -1, privateRevision: -1 });
  const first = {
    public: { stream: "public" as const, revision: 2 },
    private: { stream: "ada", revision: 3 },
  };
  expect(root.run(applyBootstrap, { input: { snapshot: first, version: 0 } })).toBe(1);
  expect(client.cursors()).toEqual({ accountId: "ada", publicRevision: 2, privateRevision: 3 });
  expect([root.resolve(savedPublic), root.resolve(savedPrivate)]).toEqual([
    first.public,
    first.private,
  ]);
  expect(root.run(applyBootstrap, { input: { snapshot: ada, version: 1 } })).toBe(1);
  expect([root.resolve(savedPublic), root.resolve(savedPrivate)]).toEqual([
    first.public,
    first.private,
  ]);
  expect(client.cursors()).toEqual({ accountId: "ada", publicRevision: 2, privateRevision: 3 });
  expect(root.run(applyBootstrap, { input: { snapshot: first, version: 7 } })).toBe(undefined);
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
  root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const client = root.resolve(syncClient);
  root.run(applyEvents, {
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
  root.run(applyEvents, { input: { version: 3, events: [event("public", 2, "stale")] } });
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
  root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const waiting = root.run(send);
  await sent.promise;
  root.run(applyEvents, {
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
  root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const waiting = root.run(send);
  await sent.promise;
  root.run(applyEvents, { input: { version: 1, events: [result("ada", 1, ids[1])] } });
  expect(await waiting).toEqual({ kind: "done" });
  root.run(applyEvents, { input: { version: 1, events: [result("ada", 2, ids[2])] } });
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
  root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
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
  root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const client = root.resolve(syncClient);
  const waiting = root.settle(send);
  await sent.promise;
  root.run(leaveAccount);
  expect(await waiting).toMatchObject({ status: "failed", error: { kind: "Cancelled" } });
  expect([root.resolve(savedPrivate), client.cursors()]).toEqual([
    null,
    { accountId: null, publicRevision: 0, privateRevision: -1 },
  ]);
  const grace = { ...ada, private: { stream: "grace", revision: 0 } };
  root.run(applyBootstrap, { input: { snapshot: grace, version: 2 } });
  root.run(applyBootstrap, { input: { snapshot: ada, version: 1 } });
  root.run(applyEvents, { input: { version: 1, events: [event("ada", 1, "late")] } });
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
  root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const client = root.resolve(syncClient);
  const writing = root.settle(send);
  await sent.promise;
  const grace = { ...ada, private: { stream: "grace", revision: 0 } };
  expect(root.run(applyBootstrap, { input: { snapshot: ada, version: 1 } })).toBe(undefined);
  expect(client.capture().version).toBe(1);
  expect(root.run(applyBootstrap, { input: { snapshot: grace, version: 1 } })).toBe(2);
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
  root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const writing = root.settle(send);
  await sent.promise;
  tab.abort();
  expect(await writing).toMatchObject({ status: "failed", error: { kind: "Cancelled" } });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

/** "settled" when the promise has settled already, else "pending": a marker queued after it. */
const settledFirst = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    Promise.resolve().then(() => "pending"),
  ]);

/**
 * A write whose send the test answers: `sent` resolves when it sends; `reply` answers it.
 * @param executionId - From a test; why: the write's id.
 * @param call - From a test; why: the signal that stops this call.
 */
function heldWrite(executionId: string, call: AbortSignal) {
  const sent = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<Sync.Reply>();
  const write = operation({
    label: "test.sync.write",
    depends: { sync: syncClient },
    run: async ({ sync }) =>
      sync.execute(
        executionId,
        {
          data: undefined,
          send: () => {
            sent.resolve();
            return reply.promise;
          },
        },
        call,
      ),
  });
  return { write, sent: sent.promise, reply };
}

test("an anonymous snapshot keeps the tab anonymous on the public stream", async () => {
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  const client = root.resolve(syncClient);
  const anonymous = { public: { stream: "public" as const, revision: 2 }, private: null };
  expect(root.run(applyBootstrap, { input: { snapshot: anonymous, version: 0 } })).toBe(0);
  expect([client.cursors(), root.resolve(savedPrivate)]).toEqual([
    { accountId: null, publicRevision: 2, privateRevision: -1 },
    null,
  ]);
  expect(client.snapshot()).toEqual(anonymous);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("an account that leaves and joins again takes its snapshot afresh", async () => {
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  const client = root.resolve(syncClient);
  root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  root.run(applyEvents, { input: { version: 1, events: [event("ada", 1, "a1")] } });
  root.run(leaveAccount);
  const older = { ...ada, private: { stream: "ada", revision: 0 } };
  root.run(applyBootstrap, { input: { snapshot: older, version: 2 } });
  expect([root.resolve(savedPrivate), client.cursors().privateRevision]).toEqual([
    older.private,
    0,
  ]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a wait for an old account version, or with a stopped signal, fails at once", async () => {
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  const client = root.resolve(syncClient);
  const old = client.wait(ids[1], 5, new AbortController().signal);
  expect(await settledFirst(old)).toBe("settled");
  await expect(old).rejects.toMatchObject({ kind: "Cancelled" });
  const stopped = new AbortController();
  stopped.abort();
  const late = client.wait(ids[1], 0, stopped.signal);
  expect(await settledFirst(late)).toBe("settled");
  await expect(late).rejects.toMatchObject({ kind: "Cancelled" });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("closing the root fails a wait that no signal stops", async () => {
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  const client = root.resolve(syncClient);
  const waiting = client.wait(ids[1], 0, new AbortController().signal);
  expect((await root.close({ graceful: true })).status).toBe("success");
  await expect(waiting).rejects.toMatchObject({ kind: "Cancelled" });
});

test("an account exit fails a wait that no signal stops", async () => {
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  const client = root.resolve(syncClient);
  const waiting = client.wait(ids[1], 0, new AbortController().signal);
  client.leave();
  await expect(waiting).rejects.toMatchObject({ kind: "Cancelled" });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a result for a write this tab did not send is not kept for a later write of that id", async () => {
  const call = new AbortController();
  const { write, sent, reply } = heldWrite(ids[2], call.signal);
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const client = root.resolve(syncClient);
  client.apply([result("ada", 1, ids[2])], 1);
  const writing = root.run(write);
  await sent;
  reply.resolve({ kind: "accepted", executionId: ids[2] });
  // The write took the reply first, so it is waiting now.
  await reply.promise;
  client.apply(
    [
      {
        stream: "ada",
        revision: 2,
        executionId: ids[2],
        payload: { kind: "result", result: "own" },
      },
    ],
    1,
  );
  expect(await writing).toBe("own");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a finished write forgets its id: a repeat waits for its own result", async () => {
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const client = root.resolve(syncClient);
  const first = heldWrite(ids[1], new AbortController().signal);
  const writing = root.run(first.write);
  await first.sent;
  first.reply.resolve({ kind: "accepted", executionId: ids[1] });
  client.apply([result("ada", 1, ids[1])], 1);
  expect(await writing).toEqual({ kind: "done" });
  client.apply(
    [
      {
        stream: "ada",
        revision: 2,
        executionId: ids[1],
        payload: { kind: "result", result: "late" },
      },
    ],
    1,
  );
  const again = heldWrite(ids[1], new AbortController().signal);
  const repeating = root.run(again.write);
  await again.sent;
  again.reply.resolve({ kind: "accepted", executionId: ids[1] });
  // The repeat took the reply first, so it is waiting now.
  await again.reply.promise;
  client.apply(
    [
      {
        stream: "ada",
        revision: 3,
        executionId: ids[1],
        payload: { kind: "result", result: "own" },
      },
    ],
    1,
  );
  expect(await repeating).toBe("own");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a call stopped before it sends fails at once, and sends nothing", async () => {
  const call = new AbortController();
  call.abort();
  const { write } = heldWrite(ids[1], call.signal);
  let sends = 0;
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  const counted = operation({
    label: "test.sync.counted",
    depends: { sync: syncClient },
    run: async ({ sync }) =>
      sync.execute(
        ids[1],
        {
          data: undefined,
          send: async () => {
            sends += 1;
            return { kind: "accepted", executionId: ids[1] };
          },
        },
        call.signal,
      ),
  });
  expect(await root.settle(counted)).toMatchObject({
    status: "failed",
    error: { kind: "Cancelled" },
  });
  expect(await root.settle(write)).toMatchObject({
    status: "failed",
    error: { kind: "Cancelled" },
  });
  expect(sends).toBe(0);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a send that fails because its call stopped fails with its own error, and is not retried", async () => {
  const call = new AbortController();
  const torn = new Error("send torn");
  const logs: string[] = [];
  const write = operation({
    label: "test.sync.torn",
    depends: { sync: syncClient },
    run: async ({ sync }) =>
      sync.execute(
        ids[1],
        {
          data: undefined,
          send: async () => {
            call.abort();
            throw torn;
          },
        },
        call.signal,
      ),
  });
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
    observe: { log: ({ message }) => logs.push(message) },
  });
  await root.ready;
  expect(await root.settle(write)).toMatchObject({ status: "failed", error: torn });
  expect(logs).toEqual([]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a result that lands as its call stops fails the call", async () => {
  const call = new AbortController();
  const { write, sent, reply } = heldWrite(ids[1], call.signal);
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const client = root.resolve(syncClient);
  const writing = root.settle(write);
  await sent;
  reply.resolve({ kind: "accepted", executionId: ids[1] });
  await Promise.resolve();
  client.apply([result("ada", 1, ids[1])], 1);
  call.abort();
  expect(await writing).toMatchObject({ status: "failed", error: { kind: "Cancelled" } });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the sync client's work shows on the trace under its own names", async () => {
  const root = createScope({
    observe: { history: 30 },
    extensions: [accountOwner],
    tags: [tabStop(new AbortController().signal), pageEvents(new EventTarget())],
  });
  await root.ready;
  root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  root.run(applyEvents, { input: { version: 1, events: [] } });
  root.run(leaveAccount);
  root.resolve(tabLifetime);
  const names = new Set(root.spans().map(({ name }) => name));
  const expected = [
    "sync.client",
    "sync.bootstrap",
    "sync.apply",
    "sync.leave",
    "router.tabLifetime",
  ];
  expect(expected.filter((name) => !names.has(name))).toEqual([]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the account owner needs the tab's stop signal bound", async () => {
  const root = createScope({ extensions: [accountOwner] });
  await expect(root.ready).rejects.toMatchObject({ payload: { label: "sync.tabStop" } });
  await root.close();
});

test("a page hide before anything is bound closes nothing; a root with no page ends clean", async () => {
  const page = new EventTarget();
  const root = createScope({ tags: pageEvents(page) });
  root.resolve(tabLifetime);
  expect(() => page.dispatchEvent(hide(false))).not.toThrow();
  expect((await root.close({ graceful: true })).status).toBe("success");
  const server = createScope();
  server.resolve(tabLifetime);
  expect(await server.close({ graceful: true })).toMatchObject({
    status: "success",
    teardownErrors: undefined,
  });
});
