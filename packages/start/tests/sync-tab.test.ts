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
  snapshotSource,
  syncStreaming,
} from "../src/parts/sync/client/events.ts";
import { accountOwner } from "../src/parts/sync/client/owner.ts";
import { syncRouter } from "../src/parts/sync/client/router.ts";
import { applyBootstrap, syncClient } from "../src/parts/sync/client/sync.ts";
import { pageEvents, tabStop } from "../src/parts/sync/client/tab.ts";
import type { Sync } from "../src/parts/sync/envelopes.ts";
import { sync as off } from "../src/parts/sync/off.ts";
import { sync as on } from "../src/parts/sync/on.ts";

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
  type Connection = { url: string; closed: boolean; emit(type: string, data?: string): void };
  const opened: Connection[] = [];
  let arrival = Promise.withResolvers<Connection>();
  const backend = (url: string) => {
    const listeners: [string, (event: MessageEvent<string>) => void][] = [];
    const connection: Connection = {
      url,
      closed: false,
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
  expect((await root.close({ graceful: true })).status).toBe("success");
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
