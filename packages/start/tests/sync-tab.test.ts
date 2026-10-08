import { createScope } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";
import { applied } from "#tinker/app";
import {
  checkAccount,
  consumeConnection,
  eventSource,
  eventSourceBackend,
  loadSnapshot,
  receiveMessage,
  refreshAccount,
  snapshotLoader,
  syncStreaming,
} from "../src/parts/sync/client/events";
import { snapshotSource } from "../src/parts/sync/functions";
import { accountOwner } from "../src/parts/sync/client/owner";
import { syncRouter } from "../src/parts/sync/client/router";
import { applyBootstrap, syncClient } from "../src/parts/sync/client/sync";
import { pageEvents, tabStop } from "../src/parts/sync/client/tab";
import type { Sync } from "../src/parts/sync/envelopes";
import { sync as off } from "../src/parts/sync/off";
import { sync as on } from "../src/parts/sync/on";

const id = "00000000-0000-4000-8000-000000000001";

const ada: Sync.Snapshot = {
  public: { stream: "public", revision: 2 },
  private: { stream: "ada", revision: 3 },
};

const changes = (...events: [string, number, unknown][]) =>
  JSON.stringify({
    kind: "changes",
    events: events.map(([stream, revision, change]) => ({
      stream,
      revision,
      executionId: id,
      payload: { kind: "change", change },
    })),
  });

const accountChange = JSON.stringify({ kind: "account-change" });

/**
 * A stand-in for EventSource, bound as eventSourceBackend: it keeps each connection it opened,
 * `emit` hands its listeners a frame, and `next` is the next connection to open.
 */
function sources() {
  type Connection = {
    url: string;
    closed: boolean;
    closes: number;
    emit(type: string, data?: string): void;
  };
  const opened: Connection[] = [];
  let arrival = Promise.withResolvers<Connection>();
  const backend = (url: string) => {
    const listeners: [string, (event: MessageEvent<string>) => void][] = [];
    const connection: Connection = {
      url,
      closed: false,
      closes: 0,
      emit: (type, data) => {
        for (const [name, listener] of listeners)
          if (name === type) listener(new MessageEvent(type, { data }));
      },
    };
    opened.push(connection);
    arrival.resolve(connection);
    arrival = Promise.withResolvers();
    return {
      addEventListener: (type: string, listener: (event: MessageEvent<string>) => void) => {
        listeners.push([type, listener]);
      },
      close: () => {
        connection.closed = true;
        connection.closes += 1;
      },
    };
  };
  return { opened, backend, next: () => arrival.promise };
}

/**
 * The network client as a test answers it: each load and account check is kept.
 * @param accounts - From a test; why: the account each check answers, in turn; the last repeats.
 */
function network(accounts: (string | null)[] = ["ada"]) {
  const calls: string[] = [];
  const source = preset(snapshotSource, () => ({
    load: async () => {
      calls.push("load");
      return ada;
    },
    account: async () => {
      calls.push("account");
      return accounts.length > 1 ? (accounts.shift() ?? null) : (accounts[0] ?? null);
    },
  }));
  return { calls, source };
}

test("a tab loads its snapshot once per account, and shares a load in flight", async () => {
  const reply = Promise.withResolvers<Sync.Snapshot>();
  let loads = 0;
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
    presets: [
      preset(snapshotSource, () => ({
        load: () => {
          loads += 1;
          return reply.promise;
        },
        account: async () => "ada",
      })),
    ],
  });
  await root.ready;
  const loader = await root.resolve(snapshotLoader);
  const signal = new AbortController().signal;
  const first = loader.load(signal);
  const shared = loader.load(signal);
  reply.resolve(ada);
  expect([await first, await shared, loads]).toEqual([ada, ada, 1]);
  expect(await root.run(loadSnapshot)).toEqual(ada);
  expect(loads).toBe(1);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("an account check keeps the same account, and leaves a changed one", async () => {
  const { calls, source } = network(["ada", "grace"]);
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
    presets: [source],
  });
  await root.ready;
  await root.run(loadSnapshot);
  const client = await root.resolve(syncClient);
  expect(await root.run(checkAccount)).toBe("ada");
  expect(client.capture().version).toBe(1);
  expect(await root.run(checkAccount)).toBe("grace");
  expect([client.capture().version, client.cursors().accountId, calls]).toEqual([
    2,
    null,
    ["load", "account", "account"],
  ]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("each snapshot load and account read stops with its call", async () => {
  const signals: AbortSignal[] = [];
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
    presets: [
      preset(snapshotSource, () => ({
        load: async ({ signal }: { signal: AbortSignal }) => {
          signals.push(signal);
          return ada;
        },
        account: async ({ signal }: { signal: AbortSignal }) => {
          signals.push(signal);
          return "ada";
        },
      })),
    ],
  });
  await root.ready;
  const call = new AbortController();
  await root.run(loadSnapshot, { signal: call.signal });
  await root.run(checkAccount, { signal: call.signal });
  await root.run(refreshAccount, { signal: call.signal });
  call.abort();
  expect(signals.map((signal) => signal?.aborted)).toEqual([true, true, true]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a sign-in holds loads and checks until it completes, with its own load", async () => {
  const { calls, source } = network();
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
    presets: [source],
  });
  await root.ready;
  const loader = await root.resolve(snapshotLoader);
  const signal = new AbortController().signal;
  const change = loader.beginAccountChange();
  const held = loader.load(signal);
  const check = loader.account(signal);
  expect(calls).toEqual([]);
  expect(await loader.completeAccountChange(signal, change)).toEqual(ada);
  expect([await held, await check, calls]).toEqual([ada, "ada", ["load", "account"]]);
  const ended = loader.beginAccountChange();
  const waiting = loader.ready();
  loader.endAccountChange(ended);
  await waiting;
  loader.endAccountChange(ended);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a frame of changes applies; an account frame leaves the account; a stale version or a bad frame does neither", async () => {
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const client = await root.resolve(syncClient);
  expect(
    await root.run(receiveMessage, {
      rawInput: { version: 1, data: changes(["public", 3, "p3"]) },
    }),
  ).toBe(false);
  expect(
    await root.run(receiveMessage, {
      rawInput: { version: 0, data: changes(["public", 4, "p4"]) },
    }),
  ).toBe(false);
  expect(root.resolve(applied)).toEqual(["p3"]);
  expect(await root.settle(receiveMessage, { rawInput: { version: 1, data: "{" } })).toMatchObject({
    status: "failed",
  });
  expect(await root.run(receiveMessage, { rawInput: { version: 0, data: accountChange } })).toBe(
    false,
  );
  expect(client.cursors().accountId).toBe("ada");
  expect(await root.run(receiveMessage, { rawInput: { version: 1, data: accountChange } })).toBe(
    true,
  );
  expect([client.cursors().accountId, client.capture().version]).toEqual([null, 2]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a connection opens from the applied cursors, applies each frame, and ends true on an account change", async () => {
  const fake = sources();
  const root = createScope({
    extensions: [accountOwner],
    tags: [tabStop(new AbortController().signal), eventSourceBackend(fake.backend)],
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const opening = fake.next();
  const consuming = root.run(consumeConnection);
  const connection = await opening;
  const cursor = { public: 2, private: { accountId: "ada", revision: 3 } };
  expect(connection.url).toBe(`/api/sync?cursor=${encodeURIComponent(JSON.stringify(cursor))}`);
  connection.emit("changes", changes(["public", 3, "p3"], ["ada", 4, "a4"]));
  connection.emit("account", accountChange);
  expect(await consuming).toBe(true);
  expect([root.resolve(applied), connection.closed]).toEqual([["p3", "a4"], true]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("an anonymous tab connects from the start of the public stream", async () => {
  const fake = sources();
  const root = createScope({
    extensions: [accountOwner],
    tags: [tabStop(new AbortController().signal), eventSourceBackend(fake.backend)],
  });
  await root.ready;
  const opening = fake.next();
  const consuming = root.run(consumeConnection);
  const connection = await opening;
  expect(connection.url).toBe(
    `/api/sync?cursor=${encodeURIComponent('{"public":0,"private":null}')}`,
  );
  connection.emit("error");
  expect(await consuming).toBe(false);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("an error, a bad frame, a ninth unread frame, or a stop ends a connection false", async () => {
  const fake = sources();
  const tab = new AbortController();
  const root = createScope({
    extensions: [accountOwner],
    tags: [tabStop(tab.signal), eventSourceBackend(fake.backend)],
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const ends: unknown[] = [];
  for (const end of [
    (connection: { emit(type: string, data?: string): void }) => connection.emit("error"),
    (connection: { emit(type: string, data?: string): void }) =>
      connection.emit("changes", "not json"),
    (connection: { emit(type: string, data?: string): void }) => {
      for (let count = 0; count < 9; count += 1)
        connection.emit("changes", changes(["public", 3 + count, count]));
    },
  ]) {
    const opening = fake.next();
    const consuming = root.run(consumeConnection);
    const connection = await opening;
    end(connection);
    ends.push(await consuming, connection.closed);
  }
  const opening = fake.next();
  const consuming = root.run(consumeConnection);
  const connection = await opening;
  tab.abort();
  ends.push(await consuming, connection.closed);
  expect(ends).toEqual([false, true, false, true, false, true, false, true]);
  expect(root.resolve(applied)).toEqual([]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("eight unread frames wait in order, and a frame after the end is dropped", async () => {
  const fake = sources();
  const root = createScope({ tags: eventSourceBackend(fake.backend) });
  const source = root.resolve(eventSource);
  source.connect({ public: 0, private: null }, new AbortController().signal);
  const connection = fake.opened[0];
  for (let count = 0; count < 8; count += 1) connection?.emit("changes", String(count));
  const read: (string | undefined)[] = [];
  for (let count = 0; count < 8; count += 1) read.push(await source.next());
  expect(read).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  source.close();
  connection?.emit("changes", "late");
  expect([await source.next(), connection?.closed]).toEqual([undefined, true]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a second connect closes the first; a stopped signal closes at once; closing the root closes the last", async () => {
  const fake = sources();
  const root = createScope({ tags: eventSourceBackend(fake.backend) });
  const source = root.resolve(eventSource);
  const signal = new AbortController().signal;
  source.connect({ public: 0, private: null }, signal);
  source.connect({ public: 1, private: null }, signal);
  const stopped = new AbortController();
  stopped.abort();
  source.connect({ public: 2, private: null }, stopped.signal);
  expect(await source.next()).toBe(undefined);
  source.connect({ public: 3, private: null }, signal);
  expect(fake.opened.map(({ closed }) => closed)).toEqual([true, true, true, false]);
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(fake.opened[3]?.closed).toBe(true);
});

test("a refresh keeps the same account's cursors, and reloads after a change", async () => {
  const { calls, source } = network(["ada", "grace"]);
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
    presets: [source],
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const client = await root.resolve(syncClient);
  await root.run(refreshAccount);
  expect([client.cursors(), calls]).toEqual([
    { accountId: "ada", publicRevision: 2, privateRevision: 3 },
    ["account"],
  ]);
  await root.run(refreshAccount);
  expect(calls).toEqual(["account", "account", "load"]);
  expect(client.capture().version).toBe(3);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a refresh that ends after an account exit leaves the new account alone", async () => {
  const answer = Promise.withResolvers<string | null>();
  const asked = Promise.withResolvers<void>();
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
    presets: [
      preset(snapshotSource, () => ({
        load: async () => ada,
        account: () => {
          asked.resolve();
          return answer.promise;
        },
      })),
    ],
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const client = await root.resolve(syncClient);
  const refreshing = root.run(refreshAccount);
  await asked.promise;
  client.leave();
  answer.resolve("grace");
  await refreshing;
  expect([client.capture().version, client.cursors().accountId]).toEqual([2, null]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the tab streams once started: an account frame reloads, an ended connection re-checks, 500 ms apart", async () => {
  const time = makeTestClock();
  let sleeping = Promise.withResolvers<number>();
  const clock = {
    currentTimeMillis: () => time.currentTimeMillis(),
    currentTimeNanos: () => time.currentTimeNanos(),
    sleep: (ms: number, signal?: AbortSignal) => {
      const slept = time.sleep(ms, signal);
      sleeping.resolve(ms);
      sleeping = Promise.withResolvers();
      return slept;
    },
  };
  const fake = sources();
  const { calls, source } = network();
  const tab = new AbortController();
  const root = createScope({
    clock,
    extensions: [accountOwner, syncStreaming],
    tags: [tabStop(tab.signal), eventSourceBackend(fake.backend)],
    presets: [source],
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const streaming = root.resolve(syncStreaming);
  const first = fake.next();
  streaming.start();
  streaming.start();
  const one = await first;
  let slept = sleeping.promise;
  one.emit("account", accountChange);
  expect(await slept).toBe(500);
  expect(calls).toEqual(["load"]);
  const second = fake.next();
  time.advance(500);
  const two = await second;
  slept = sleeping.promise;
  two.emit("error");
  expect(await slept).toBe(500);
  expect([calls, fake.opened.length]).toEqual([["load", "account"], 2]);
  tab.abort();
  const closed = await root.close({ graceful: true });
  expect([closed.status, closed.teardownErrors]).toEqual(["success", undefined]);
  expect(fake.opened.length).toBe(2);
});

test("a connection that fails to open logs a reconnect, and the tab tries again", async () => {
  const time = makeTestClock();
  let sleeping = Promise.withResolvers<number>();
  const clock = {
    currentTimeMillis: () => time.currentTimeMillis(),
    currentTimeNanos: () => time.currentTimeNanos(),
    sleep: (ms: number, signal?: AbortSignal) => {
      const slept = time.sleep(ms, signal);
      sleeping.resolve(ms);
      sleeping = Promise.withResolvers();
      return slept;
    },
  };
  const logs: string[] = [];
  const { calls, source } = network([null]);
  const tab = new AbortController();
  const root = createScope({
    clock,
    observe: { log: ({ message }) => logs.push(message) },
    extensions: [accountOwner, syncStreaming],
    tags: [
      tabStop(tab.signal),
      eventSourceBackend(() => {
        throw new TypeError("no stream");
      }),
    ],
    presets: [source],
  });
  await root.ready;
  const slept = sleeping.promise;
  root.resolve(syncStreaming).start();
  expect(await slept).toBe(500);
  expect([logs, calls]).toEqual([["sync.reconnecting"], ["account"]]);
  tab.abort();
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the router side loads and checks through the loader, dehydrates, and hydrates then streams", async () => {
  const fake = sources();
  const { calls, source } = network();
  const page = new EventTarget();
  const tab = new AbortController();
  const root = createScope({
    extensions: on.extensions,
    tags: [tabStop(tab.signal), pageEvents(page), eventSourceBackend(fake.backend)],
    presets: [source],
  });
  await root.ready;
  const router = await root.resolve(on.router);
  expect(router).toBe(await root.resolve(syncRouter));
  expect(await router.options.context.bootstrap()).toEqual(ada);
  expect(await router.options.context.account()).toBe("ada");
  expect(router.options.dehydrate()).toEqual(ada);
  expect(calls).toEqual(["load", "account"]);
  const opening = fake.next();
  await router.options.hydrate({ ...ada, public: { stream: "public", revision: 5 } });
  expect((await opening).url).toBe(
    `/api/sync?cursor=${encodeURIComponent('{"public":5,"private":{"accountId":"ada","revision":3}}')}`,
  );
  await expect(router.options.hydrate({ public: {} })).rejects.toThrow();
  let closes = 0;
  router.bind(async () => {
    closes += 1;
  });
  page.dispatchEvent(new Event("pagehide"));
  expect(closes).toBe(1);
  tab.abort();
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the on part streams through the tab's owner; the off part adds nothing and binds nothing", async () => {
  expect(on.extensions).toEqual([accountOwner, syncStreaming]);
  const root = createScope({ extensions: off.extensions });
  await root.ready;
  const router = await root.resolve(off.router);
  expect(router.options).toEqual({});
  expect(() => router.bind(async () => undefined)).not.toThrow();
  expect(off.extensions).toEqual([]);
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

test("a tab whose snapshot came another way still loads its own at the next version", async () => {
  const { calls, source } = network();
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
    presets: [source],
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  expect(await root.run(loadSnapshot)).toEqual(ada);
  expect(calls).toEqual(["load"]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a load that cannot apply yet is tried again; a newer load is not dropped when an older one ends", async () => {
  const replies: PromiseWithResolvers<Sync.Snapshot>[] = [];
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
    presets: [
      preset(snapshotSource, () => ({
        load: () => {
          const reply = Promise.withResolvers<Sync.Snapshot>();
          replies.push(reply);
          return reply.promise;
        },
        account: async () => "ada",
      })),
    ],
  });
  await root.ready;
  const loader = await root.resolve(snapshotLoader);
  const client = await root.resolve(syncClient);
  const signal = new AbortController().signal;
  const older = loader.load(signal);
  await Promise.resolve();
  client.leave();
  const newer = loader.load(signal);
  await Promise.resolve();
  replies[0]?.resolve(ada);
  await older;
  const shared = loader.load(signal);
  expect(replies).toHaveLength(2);
  replies[1]?.resolve({ ...ada, private: null });
  expect([await newer, await shared]).toEqual([
    { public: ada.public, private: null },
    { public: ada.public, private: null },
  ]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a snapshot that cannot apply while a write is pending is loaded again", async () => {
  const { calls, source } = network();
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
    presets: [source],
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const client = await root.resolve(syncClient);
  const sent = Promise.withResolvers<void>();
  const pending = client.execute(
    id,
    { data: undefined, send: () => (sent.resolve(), new Promise<Sync.Reply>(() => undefined)) },
    new AbortController().signal,
  );
  pending.catch(() => undefined);
  await sent.promise;
  await root.run(loadSnapshot);
  await root.run(loadSnapshot);
  expect(calls).toEqual(["load", "load"]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("an account change begun twice holds the tab until the latest one ends", async () => {
  const { source } = network();
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
    presets: [source],
  });
  await root.ready;
  const loader = await root.resolve(snapshotLoader);
  const order: string[] = [];
  const first = loader.beginAccountChange();
  const latest = loader.beginAccountChange();
  loader.endAccountChange(first);
  void loader.ready().then(() => order.push("ready"));
  await Promise.resolve();
  void latest.promise.then(() => order.push("latest ended"));
  loader.endAccountChange(latest);
  await loader.ready();
  const again = loader.beginAccountChange();
  const newest = loader.beginAccountChange();
  await loader.completeAccountChange(new AbortController().signal, again);
  void loader.ready().then(() => order.push("ready again"));
  await Promise.resolve();
  void newest.promise.then(() => order.push("newest ended"));
  loader.endAccountChange(newest);
  await loader.ready();
  expect(order).toEqual(["latest ended", "ready", "newest ended", "ready again"]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("frames from an old connection after a reconnect are dropped", async () => {
  const fake = sources();
  const root = createScope({ tags: eventSourceBackend(fake.backend) });
  const source = root.resolve(eventSource);
  const signal = new AbortController().signal;
  source.connect({ public: 0, private: null }, signal);
  source.close();
  source.close();
  fake.opened[0]?.emit("changes", "stale");
  source.connect({ public: 0, private: null }, signal);
  fake.opened[1]?.emit("changes", "fresh");
  expect([await source.next(), fake.opened[0]?.closes]).toEqual(["fresh", 1]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("before any connection, close does nothing and next ends at once; a root that never connected closes clean", async () => {
  const fake = sources();
  const root = createScope({ tags: eventSourceBackend(fake.backend) });
  const source = root.resolve(eventSource);
  expect(() => source.close()).not.toThrow();
  const next = source.next();
  expect(await settledFirst(next)).toBe("settled");
  expect(await next).toBe(undefined);
  expect(await root.close({ graceful: true })).toMatchObject({
    status: "success",
    teardownErrors: undefined,
  });
});

test("a connection that applies changes, then errors, ends false", async () => {
  const fake = sources();
  const root = createScope({
    extensions: [accountOwner],
    tags: [tabStop(new AbortController().signal), eventSourceBackend(fake.backend)],
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const landed = Promise.withResolvers<void>();
  const stopWatching = root.controller(applied).watch(() => landed.resolve());
  const opening = fake.next();
  const consuming = root.run(consumeConnection);
  const connection = await opening;
  connection.emit("changes", changes(["public", 3, "p3"]));
  await landed.promise;
  stopWatching();
  connection.emit("error");
  expect(await consuming).toBe(false);
  expect(root.resolve(applied)).toEqual(["p3"]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the tab logs a reconnect only after a failure, and checks nothing more once it stops", async () => {
  const time = makeTestClock();
  let sleeping = Promise.withResolvers<number>();
  const clock = {
    currentTimeMillis: () => time.currentTimeMillis(),
    currentTimeNanos: () => time.currentTimeNanos(),
    sleep: (ms: number, signal?: AbortSignal) => {
      const slept = time.sleep(ms, signal);
      sleeping.resolve(ms);
      sleeping = Promise.withResolvers();
      return slept;
    },
  };
  const fake = sources();
  const logs: string[] = [];
  const calls: string[] = [];
  const tab = new AbortController();
  const root = createScope({
    clock,
    observe: { log: ({ message }) => logs.push(message) },
    extensions: [accountOwner, syncStreaming],
    tags: [tabStop(tab.signal), eventSourceBackend(fake.backend)],
    presets: [
      preset(snapshotSource, () => ({
        load: async () => {
          calls.push("load");
          throw new TypeError("offline");
        },
        account: async () => {
          calls.push("account");
          return "ada";
        },
      })),
    ],
  });
  await root.ready;
  await root.run(applyBootstrap, { input: { snapshot: ada, version: 0 } });
  const opening = fake.next();
  root.resolve(syncStreaming).start();
  const one = await opening;
  const slept = sleeping.promise;
  one.emit("account", accountChange);
  expect(await slept).toBe(500);
  expect([calls, logs]).toEqual([["load"], ["sync.reconnecting"]]);
  const reopening = fake.next();
  time.advance(500);
  const two = await reopening;
  tab.abort();
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect([calls, logs, two.closed]).toEqual([["load"], ["sync.reconnecting"], true]);
});

test("a tab stream that fails surfaces its error when the tab closes", async () => {
  const torn = new Error("clock torn");
  const time = makeTestClock();
  const slept = Promise.withResolvers<void>();
  const clock = {
    currentTimeMillis: () => time.currentTimeMillis(),
    currentTimeNanos: () => time.currentTimeNanos(),
    sleep: async () => {
      slept.resolve();
      throw torn;
    },
  };
  const fake = sources();
  const tab = new AbortController();
  const root = createScope({
    clock,
    extensions: [accountOwner, syncStreaming],
    tags: [
      tabStop(tab.signal),
      eventSourceBackend(() => {
        throw new TypeError("no stream");
      }),
    ],
    presets: [network().source],
  });
  await root.ready;
  root.resolve(syncStreaming).start();
  await slept.promise;
  expect(await root.close({ graceful: true })).toMatchObject({ teardownErrors: [torn] });
  expect(fake.opened).toHaveLength(0);
});

test("the tab's sync work shows on the trace under its own names", async () => {
  const fake = sources();
  const tab = new AbortController();
  const root = createScope({
    observe: { history: 60 },
    extensions: [accountOwner, syncStreaming],
    tags: [tabStop(tab.signal), eventSourceBackend(fake.backend)],
    presets: [network().source],
  });
  await root.ready;
  await root.run(loadSnapshot);
  await root.run(checkAccount);
  await root.run(refreshAccount);
  await root.run(receiveMessage, { rawInput: { version: 1, data: changes() } });
  const opening = fake.next();
  const consuming = root.run(consumeConnection);
  (await opening).emit("error");
  await consuming;
  await root.resolve(syncRouter);
  const streaming = fake.next();
  root.resolve(syncStreaming).start();
  await streaming;
  tab.abort();
  expect((await root.close({ graceful: true })).status).toBe("success");
  const names = new Set(root.spans().map(({ name }) => name));
  const expected = [
    "sync.snapshotLoader",
    "sync.load",
    "sync.checkAccount",
    "sync.refreshAccount",
    "sync.receive",
    "sync.connection",
    "sync.eventSource",
    "sync.router",
    "sync.listen",
  ];
  expect(expected.filter((name) => !names.has(name))).toEqual([]);
});
