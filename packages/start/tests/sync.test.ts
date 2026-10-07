import { createScope, operation } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { auth, database, signedIn, syncTemplate } from "#tinker/app.server";
import { requestHeaders } from "../src/backend/headers.server";
import { backendStop, requestStop } from "../src/backend/lifetime";
import { eventHistory } from "../src/parts/sync/history.server";
import { notifications } from "../src/parts/sync/notifications.server";
import { execution } from "../src/parts/sync/schema";
import { eventStream, openSync } from "../src/parts/sync/stream.server";
import { syncEndpoint } from "../src/parts/sync/endpoint.server";

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];

/** An app write: lock the stream, then append its changes, in one transaction. */
const publish = operation({
  label: "test.publish",
  input: z.object({ stream: z.string(), executionId: z.string(), changes: z.array(z.unknown()) }),
  depends: { database, history: eventHistory },
  run: async ({ database, history }, { input }) =>
    database.transaction(async (tx) => {
      await history.lock(tx, input.stream);
      await history.append(
        tx,
        input.stream,
        input.executionId,
        input.changes.map((change) => ({ kind: "change" as const, change })),
      );
    }),
});
const rolledBack = operation({
  label: "test.rolledBack",
  depends: { database, history: eventHistory },
  run: async ({ database, history }, { raise }) =>
    database.transaction(async (tx) => {
      await history.lock(tx, "public");
      await history.append(tx, "public", ids[0], [{ kind: "change", change: 1 }]);
      raise("Rollback", {});
    }),
});

/**
 * The text of the stream's next chunk; "" once it ends.
 * @param read - From a test's reader; why: one pending or new read.
 */
async function text(read: Promise<ReadableStreamReadResult<Uint8Array>>) {
  const { value } = await read;
  return value === undefined ? "" : new TextDecoder().decode(value);
}

/**
 * The frame a stream sends for these rows and this cursor.
 * @param rows - From a test; why: the events the frame carries, as the table holds them.
 * @param cursor - From a test; why: where the client resumes after them.
 */
function changesFrame(rows: object[], cursor: object) {
  return `event: changes\nid: ${JSON.stringify(cursor)}\ndata: ${JSON.stringify({ kind: "changes", events: rows })}\n\n`;
}
const row = (stream: string, revision: number, executionId: string, change: unknown) => ({
  stream,
  revision,
  executionId,
  payload: { kind: "change", change },
});
const account = 'event: account\ndata: {"kind":"account-change"}\n\n';

test("a wait holds until a wake, a close, or a stop, and returns at once when it has nothing to wait for", async () => {
  const { db, wake } = handWoken();
  const root = createScope({ presets: [db] });
  const feed = await root.resolve(notifications);
  const subscription = await feed.subscribe();
  const stop = new AbortController();
  const waiting = feed.wait(subscription, feed.revision(), stop.signal);
  const held = subscription.waiting;
  expect(held).toBeDefined();
  expect(await settledFirst(waiting)).toBe("pending");
  stop.abort();
  expect(await settledFirst(held?.promise ?? waiting)).toBe("settled");
  await waiting;
  expect(subscription.waiting).toBeUndefined();
  const woken = feed.wait(subscription, feed.revision(), new AbortController().signal);
  wake();
  await woken;
  const moved = feed.wait(subscription, 0, new AbortController().signal);
  expect(subscription.waiting).toBeUndefined();
  await moved;
  const stopped = new AbortController();
  stopped.abort();
  const late = feed.wait(subscription, feed.revision(), stopped.signal);
  expect(subscription.waiting).toBeUndefined();
  await late;
  const closing = feed.wait(subscription, feed.revision(), new AbortController().signal);
  feed.close(subscription);
  await closing;
  const closed = feed.wait(subscription, feed.revision(), new AbortController().signal);
  expect(subscription.waiting).toBeUndefined();
  await closed;
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a wait on a broken listener returns at once", async () => {
  const failures: (() => void)[] = [];
  const root = createScope({
    presets: [
      preset(database, async (_deps, { defer }) => {
        const { drizzle } = await import("drizzle-orm/pglite");
        const client = await syncTemplate.clone();
        defer(() => client.close());
        return Object.assign(drizzle({ client }), {
          listen: async (_wake: () => void, failed: () => void) => {
            failures.push(failed);
            return () => undefined;
          },
        });
      }),
    ],
  });
  const feed = await root.resolve(notifications);
  const subscription = await feed.subscribe();
  failures[0]?.();
  const broken = feed.wait(subscription, feed.revision(), new AbortController().signal);
  expect(subscription.waiting).toBeUndefined();
  await broken;
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("notifications wake after a commit, stay silent on a rollback, and a read before waiting still wakes", async () => {
  const root = createScope();
  const feed = await root.resolve(notifications);
  const subscription = await feed.subscribe();
  const before = feed.revision();
  expect(await root.settle(rolledBack)).toMatchObject({ status: "failed" });
  expect(feed.revision()).toBe(before);
  await root.run(publish, { input: { stream: "public", executionId: ids[0], changes: [1] } });
  await feed.wait(subscription, before, new AbortController().signal);
  expect(feed.revision()).toBeGreaterThan(before);
  expect(feed.ended(subscription)).toBe(false);
  feed.close(subscription);
  expect(feed.ended(subscription)).toBe(true);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the stream replays after its cursor in one frame, greets once, then sends each new commit", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
  });
  await root.run(publish, { input: { stream: "public", executionId: ids[0], changes: [1, 2] } });
  const session = root.createSession();
  const body = await session.run(openSync, { input: { cursor: { public: 0, private: null } } });
  const reader = body.getReader();
  expect(await text(reader.read())).toBe(
    changesFrame([row("public", 1, ids[0], 1), row("public", 2, ids[0], 2)], {
      public: 2,
      private: null,
    }),
  );
  expect(await text(reader.read())).toBe(": connected\n\n");
  const held = reader.read();
  await root.run(publish, { input: { stream: "public", executionId: ids[1], changes: [3] } });
  expect(await text(held)).toBe(
    changesFrame([row("public", 3, ids[1], 3)], { public: 3, private: null }),
  );
  const idle = reader.read();
  await reader.cancel();
  expect((await idle).done).toBe(true);
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a resumed cursor skips what it has; one frame carries at most 100 events", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
  });
  const many = Array.from({ length: 102 }, (_, index) => index + 1);
  await root.run(publish, { input: { stream: "public", executionId: ids[0], changes: many } });
  const session = root.createSession();
  const body = await session.run(openSync, { input: { cursor: { public: 1, private: null } } });
  const reader = body.getReader();
  const rows = many.slice(1).map((value) => row("public", value, ids[0], value));
  expect(await text(reader.read())).toBe(
    changesFrame(rows.slice(0, 100), { public: 101, private: null }),
  );
  expect(await text(reader.read())).toBe(
    changesFrame(rows.slice(100), { public: 102, private: null }),
  );
  expect(await text(reader.read())).toBe(": connected\n\n");
  await reader.cancel();
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("an account's own private events replay beside the public ones; another account's cursor is refused", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), signedIn(new Set(["ada", "grace"]))],
  });
  await root.run(publish, { input: { stream: "ada", executionId: ids[0], changes: ["a1"] } });
  await root.run(publish, { input: { stream: "grace", executionId: ids[1], changes: ["g1"] } });
  await root.run(publish, { input: { stream: "public", executionId: ids[2], changes: [1] } });
  const cursor = { public: 0, private: { accountId: "ada", revision: 0 } };
  const grace = root.createSession({ tags: requestHeaders(new Headers({ "x-account": "grace" })) });
  expect(await grace.settle(openSync, { input: { cursor } })).toMatchObject({
    status: "failed",
    error: { kind: "StreamDenied" },
  });
  expect((await grace.close({ graceful: true })).status).toBe("success");
  const ada = root.createSession({ tags: requestHeaders(new Headers({ "x-account": "ada" })) });
  const reader = (await ada.run(openSync, { input: { cursor } })).getReader();
  expect(await text(reader.read())).toBe(
    changesFrame([row("ada", 1, ids[0], "a1"), row("public", 1, ids[2], 1)], {
      public: 1,
      private: { accountId: "ada", revision: 1 },
    }),
  );
  await reader.cancel();
  expect((await ada.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a held stream whose account signs out sends the account frame, then no saved rows", async () => {
  const stop = new AbortController();
  const accounts = new Set(["ada"]);
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), signedIn(accounts)],
  });
  const ada = root.createSession({ tags: requestHeaders(new Headers({ "x-account": "ada" })) });
  const reader = (
    await ada.run(openSync, {
      input: { cursor: { public: 0, private: { accountId: "ada", revision: 0 } } },
    })
  ).getReader();
  expect(await text(reader.read())).toBe(": connected\n\n");
  const held = reader.read();
  accounts.delete("ada");
  await root.run(publish, { input: { stream: "ada", executionId: ids[0], changes: ["secret"] } });
  expect(await text(held)).toBe(account);
  expect((await reader.read()).done).toBe(true);
  expect((await ada.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("an anonymous stream that signs in is an account change too", async () => {
  const stop = new AbortController();
  const accounts = new Set<string>();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), signedIn(accounts)],
  });
  const tab = root.createSession({ tags: requestHeaders(new Headers({ "x-account": "ada" })) });
  const reader = (
    await tab.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();
  expect(await text(reader.read())).toBe(": connected\n\n");
  const held = reader.read();
  accounts.add("ada");
  await root.run(publish, { input: { stream: "public", executionId: ids[0], changes: [1] } });
  expect(await text(held)).toBe(account);
  expect((await reader.read()).done).toBe(true);
  expect((await tab.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a quiet stream sends a heartbeat each 10 s, closes at its 30 s lease, and at a heartbeat after sign-out", async () => {
  const clock = makeTestClock();
  const stop = new AbortController();
  const accounts = new Set(["ada"]);
  const root = createScope({
    clock,
    tags: [backendStop(stop.signal), requestStop(stop.signal), signedIn(accounts)],
  });
  const quiet = root.createSession({ tags: requestHeaders(new Headers()) });
  const reader = (
    await quiet.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();
  expect(await text(reader.read())).toBe(": connected\n\n");
  for (const at of [10_000, 20_000]) {
    const held = reader.read();
    await settledFirst(held);
    clock.advance(10_000);
    expect([at, await text(held)]).toEqual([at, ": heartbeat\n\n"]);
  }
  clock.advance(10_000);
  expect((await reader.read()).done).toBe(true);
  expect((await quiet.close({ graceful: true })).status).toBe("success");
  const ada = root.createSession({ tags: requestHeaders(new Headers({ "x-account": "ada" })) });
  const own = (
    await ada.run(openSync, {
      input: { cursor: { public: 0, private: { accountId: "ada", revision: 0 } } },
    })
  ).getReader();
  expect(await text(own.read())).toBe(": connected\n\n");
  const held = own.read();
  await settledFirst(held);
  accounts.delete("ada");
  clock.advance(10_000);
  expect(await text(held)).toBe(account);
  expect((await own.read()).done).toBe(true);
  expect((await ada.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a stream whose request stopped while it opened is Cancelled", async () => {
  const backend = new AbortController();
  const root = createScope({
    tags: [backendStop(backend.signal), requestHeaders(new Headers())],
  });
  const request = new AbortController();
  const session = root.createSession({ tags: requestStop(request.signal) });
  const opening = session.settle(openSync, { input: { cursor: { public: 0, private: null } } });
  request.abort();
  expect(await opening).toMatchObject({ status: "failed", error: { kind: "Cancelled" } });
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a backend stop ends a held stream, and the request ends clean", async () => {
  const backend = new AbortController();
  const root = createScope({
    tags: [
      backendStop(backend.signal),
      requestStop(new AbortController().signal),
      requestHeaders(new Headers()),
    ],
  });
  const session = root.createSession();
  const reader = (
    await session.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();
  expect(await text(reader.read())).toBe(": connected\n\n");
  const held = reader.read();
  backend.abort();
  expect((await held).done).toBe(true);
  expect(await session.close({ graceful: true })).toMatchObject({
    status: "success",
    teardownErrors: undefined,
  });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a listener that cannot start fails the subscribe; one that breaks ends its subscribers", async () => {
  const refused = new Error("listen refused");
  const listens: { wake: () => void; failed: () => void; stopped: boolean }[] = [];
  const root = createScope({
    presets: [
      preset(database, async (_deps, { defer }) => {
        const { drizzle } = await import("drizzle-orm/pglite");
        const client = await syncTemplate.clone();
        defer(() => client.close());
        return Object.assign(drizzle({ client }), {
          listen: async (wake: () => void, failed: () => void) => {
            if (listens.length === 0) {
              listens.push({ wake, failed, stopped: true });
              throw refused;
            }
            const listen = { wake, failed, stopped: false };
            listens.push(listen);
            return () => {
              listen.stopped = true;
            };
          },
        });
      }),
    ],
  });
  const feed = await root.resolve(notifications);
  await expect(feed.subscribe()).rejects.toBe(refused);
  let disconnected = 0;
  const first = await feed.subscribe(() => {
    disconnected += 1;
  });
  listens[1]?.failed();
  expect([disconnected, feed.ended(first)]).toEqual([1, true]);
  const second = await feed.subscribe();
  expect([listens.length, listens[1]?.stopped, feed.ended(second)]).toEqual([3, true, false]);
  expect(feed.ended(first)).toBe(true);
  await feed.subscribe();
  expect(listens).toHaveLength(3);
  let gone = 0;
  const left = await feed.subscribe(() => {
    gone += 1;
  });
  feed.close(left);
  listens[2]?.wake();
  await feed.wait(second, 0, new AbortController().signal);
  expect([feed.revision(), disconnected, gone]).toEqual([2, 2, 0]);
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(listens[2]?.stopped).toBe(true);
});

test("a root that never listened closes clean", async () => {
  const quiet = createScope();
  await quiet.resolve(notifications);
  expect(await quiet.close({ graceful: true })).toMatchObject({
    status: "success",
    teardownErrors: undefined,
  });
});

test("closing the root wakes and disconnects each subscriber", async () => {
  const root = createScope();
  const feed = await root.resolve(notifications);
  let disconnected = 0;
  const subscription = await feed.subscribe(() => {
    disconnected += 1;
  });
  const waiting = feed.wait(subscription, feed.revision(), new AbortController().signal);
  expect(await root.close({ graceful: true })).toMatchObject({
    status: "success",
    teardownErrors: undefined,
  });
  await waiting;
  expect(disconnected).toBe(1);
});

test("the sync route answers each request with the stream or its status", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [
      backendStop(stop.signal),
      requestStop(stop.signal),
      signedIn(new Set(["ada"])),
      requestHeaders(new Headers()),
    ],
  });
  const ada = encodeURIComponent('{"public":0,"private":{"accountId":"ada","revision":0}}');
  for (const row of [
    { name: "open", search: "", last: null, status: 200 },
    {
      name: "a cursor",
      search: "?cursor=%7B%22public%22%3A0%2C%22private%22%3Anull%7D",
      last: null,
      status: 200,
    },
    { name: "resume", search: "?cursor=bad", last: '{"public":0,"private":null}', status: 200 },
    { name: "a later cursor", search: "", last: '{"public":5,"private":null}', status: 200 },
    { name: "bad cursor", search: "?cursor=bad", last: null, status: 400 },
    { name: "bad cursor shape", search: "?cursor=%7B%7D", last: null, status: 400 },
    { name: "long Last-Event-ID", search: "", last: "x".repeat(2049), status: 400 },
    { name: "another account", search: `?cursor=${ada}`, last: null, status: 403 },
  ]) {
    const session = root.createSession();
    const request = new Request(`http://localhost/api/sync${row.search}`, {
      headers: row.last ? { "Last-Event-ID": row.last } : {},
    });
    const response = await session.resolve(syncEndpoint).answer(request);
    const reader = response.body?.getReader();
    const body = reader ? await text(reader.read()) : "";
    await reader?.cancel();
    expect({ status: response.status, headers: [...response.headers], body }, row.name).toEqual({
      status: row.status,
      headers:
        row.status === 200
          ? [
              ["cache-control", "no-store"],
              ["content-type", "text/event-stream; charset=utf-8"],
              ["x-accel-buffering", "no"],
            ]
          : [],
      body: row.status === 200 ? ": connected\n\n" : "",
    });
    expect((await session.close({ graceful: true })).status).toBe("success");
  }
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a request that fails to read, or a stream that fails to open, fails the reply, not as a 400", async () => {
  const torn = new Error("request read failed");
  const opened = new Error("stream failed");
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
    presets: [
      preset(eventStream, async () => ({
        open: async (): Promise<ReadableStream<Uint8Array>> => {
          throw opened;
        },
      })),
    ],
  });
  const unreadable = Object.defineProperty(new Request("http://localhost/api/sync"), "url", {
    get: () => {
      throw torn;
    },
  });
  await expect(root.resolve(syncEndpoint).answer(unreadable)).rejects.toBe(torn);
  await expect(
    root.resolve(syncEndpoint).answer(new Request("http://localhost/api/sync")),
  ).rejects.toBe(opened);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the event history locks a stream, appends in order, saves a result, and keeps owners apart", async () => {
  const save = operation({
    label: "test.save",
    depends: { database, history: eventHistory },
    run: async ({ database, history }) =>
      database.transaction(async (tx) => {
        const locked = [await history.lock(tx, "ada")];
        await tx.insert(execution).values({ id: ids[0], stream: "ada" });
        await history.append(tx, "ada", ids[0], [
          { kind: "change", change: "a" },
          { kind: "result", result: { kind: "complete" } },
        ]);
        locked.push(await history.lock(tx, "ada"));
        return {
          locked,
          found: await history.find(tx, ids[0], "ada"),
          unknown: await history.find(tx, ids[1], "ada"),
        };
      }),
  });
  const denied = operation({
    label: "test.denied",
    depends: { database, history: eventHistory },
    run: async ({ database, history }) =>
      database.transaction(async (tx) => history.find(tx, ids[0], "grace")),
  });
  const unlocked = operation({
    label: "test.unlocked",
    depends: { database, history: eventHistory },
    run: async ({ database, history }) =>
      database.transaction(async (tx) =>
        history.append(tx, "never-locked", ids[2], [{ kind: "change", change: 1 }]),
      ),
  });
  const root = createScope();
  expect(await root.run(save)).toEqual({
    locked: [0, 2],
    found: { id: ids[0], stream: "ada", notification: null, result: { kind: "complete" } },
    unknown: undefined,
  });
  expect(await root.settle(denied)).toMatchObject({
    status: "failed",
    error: { kind: "StreamDenied" },
  });
  expect(await root.settle(unlocked)).toMatchObject({
    status: "failed",
    error: { kind: "StreamMissing" },
  });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the stream reads the account with no cookie cache and no refresh", async () => {
  const asked: unknown[] = [];
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
    presets: [
      preset(auth, () => ({
        handler: async () => new Response(null),
        api: {
          getSession: async ({ query }: { headers: Headers; query?: object }) => {
            asked.push(query);
            return null;
          },
        },
      })),
    ],
  });
  const session = root.createSession();
  const reader = (
    await session.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();
  expect(await text(reader.read())).toBe(": connected\n\n");
  await reader.cancel();
  expect(asked[0]).toEqual({ disableCookieCache: true, disableRefresh: true });
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a body cancelled while it waits stops its wait at once", async () => {
  const time = makeTestClock();
  const slept = Promise.withResolvers<AbortSignal | undefined>();
  const clock = {
    currentTimeMillis: () => time.currentTimeMillis(),
    currentTimeNanos: () => time.currentTimeNanos(),
    sleep: (ms: number, signal?: AbortSignal) => {
      slept.resolve(signal);
      return time.sleep(ms, signal);
    },
  };
  const stop = new AbortController();
  const root = createScope({
    clock,
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
  });
  const session = root.createSession();
  const reader = (
    await session.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();
  expect(await text(reader.read())).toBe(": connected\n\n");
  const held = reader.read();
  const waiting = await slept.promise;
  await reader.cancel();
  expect(waiting?.aborted).toBe(true);
  expect((await held).done).toBe(true);
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a graceful close of the request ends a held read", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
  });
  const session = root.createSession();
  const reader = (
    await session.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();
  expect(await text(reader.read())).toBe(": connected\n\n");
  const held = reader.read();
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await held).done).toBe(true);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a stream opened after a wake still replays; a signed-in tab with no account cursor gets the account frame at once", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), signedIn(new Set(["ada"]))],
  });
  const feed = await root.resolve(notifications);
  const subscription = await feed.subscribe();
  await root.run(publish, { input: { stream: "public", executionId: ids[0], changes: [1] } });
  await feed.wait(subscription, 0, new AbortController().signal);
  feed.close(subscription);
  expect(feed.revision()).toBe(1);
  const guest = root.createSession({ tags: requestHeaders(new Headers()) });
  const replayed = (
    await guest.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();
  expect(await text(replayed.read())).toBe(
    changesFrame([row("public", 1, ids[0], 1)], { public: 1, private: null }),
  );
  await replayed.cancel();
  expect((await guest.close({ graceful: true })).status).toBe("success");
  const ada = root.createSession({ tags: requestHeaders(new Headers({ "x-account": "ada" })) });
  const reader = (
    await ada.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();
  expect(await text(reader.read())).toBe(account);
  expect((await reader.read()).done).toBe(true);
  expect((await ada.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a request that stops while its account is read gets a body that has already ended", async () => {
  const request = new AbortController();
  const backend = new AbortController();
  const root = createScope({
    tags: [backendStop(backend.signal), requestHeaders(new Headers())],
    presets: [
      preset(auth, () => ({
        handler: async () => new Response(null),
        api: {
          getSession: async () => {
            request.abort();
            return null;
          },
        },
      })),
    ],
  });
  const session = root.createSession({ tags: requestStop(request.signal) });
  const reader = (
    await session.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();
  expect((await reader.read()).done).toBe(true);
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a query that fails errors the body, and the request still ends clean", async () => {
  const dropEvents = operation({
    label: "test.dropEvents",
    depends: { database },
    run: async ({ database }) => {
      const { sql } = await import("drizzle-orm");
      await database.execute(sql`DROP TABLE sync_event`);
    },
  });
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
  });
  const session = root.createSession();
  const reader = (
    await session.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();
  await root.run(dropEvents);
  await expect(reader.read()).rejects.toThrow("sync_event");
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the sync part's work shows on the trace under its own names", async () => {
  const stop = new AbortController();
  const root = createScope({
    observe: { history: 50 },
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
  });
  await root.run(publish, { input: { stream: "public", executionId: ids[0], changes: [1] } });
  const session = root.createSession();
  const response = await session
    .resolve(syncEndpoint)
    .answer(new Request("http://localhost/api/sync"));
  const reader = response.body?.getReader();
  await reader?.read();
  await reader?.cancel();
  expect((await session.close({ graceful: true })).status).toBe("success");
  const names = new Set(root.spans().map(({ name }) => name));
  const parts = ["history", "endpoint", "open", "stream", "notifications", "liveAccount"];
  expect(parts.filter((part) => !names.has(`sync.${part}`))).toEqual([]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

/**
 * The fixture database without its native listener: the test wakes streams by hand, so a commit
 * wakes none by itself.
 */
function handWoken(logQuery?: (query: string) => void) {
  const wakes: (() => void)[] = [];
  const db = preset(database, async (_deps, { defer }) => {
    const { drizzle } = await import("drizzle-orm/pglite");
    const client = await syncTemplate.clone();
    defer(() => client.close());
    return Object.assign(drizzle({ client, logger: logQuery ? { logQuery } : undefined }), {
      listen: async (wake: () => void) => {
        wakes.push(wake);
        return () => undefined;
      },
    });
  });
  return { db, wake: () => wakes.forEach((wake) => wake()) };
}

/**
 * An auth library whose account reads answer in turn; the last answer repeats. `during` runs
 * inside the read of that number (1-based), before it answers.
 * @param answers - From a test; why: the account each read sees.
 * @param during - From a test; why: what happens while one read is in flight.
 */
function accountReads(answers: (string | null)[], during: Record<number, () => void> = {}) {
  let reads = 0;
  const auth_ = preset(auth, () => ({
    handler: async () => new Response(null),
    api: {
      getSession: async () => {
        reads += 1;
        during[reads]?.();
        const id = answers[Math.min(reads, answers.length) - 1] ?? null;
        return id === null ? null : { user: { id } };
      },
    },
  }));
  return { auth: auth_, reads: () => reads };
}

/** "settled" when the promise has settled already, else "pending": a marker queued after it. */
const settledFirst = (promise: Promise<unknown>) =>
  Promise.race([promise.then(() => "settled"), Promise.resolve().then(() => "pending")]);

test("only the check before the rows read can catch a sign-out whose rows cannot be read", async () => {
  const dropEvents = operation({
    label: "test.dropEvents",
    depends: { database },
    run: async ({ database }) => {
      const { sql } = await import("drizzle-orm");
      await database.execute(sql`DROP TABLE sync_event`);
    },
  });
  const { db, wake } = handWoken();
  const reads = accountReads(["ada", null]);
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal)],
    presets: [db, reads.auth],
  });
  const session = root.createSession({ tags: requestHeaders(new Headers()) });
  const reader = (
    await session.run(openSync, {
      input: { cursor: { public: 0, private: { accountId: "ada", revision: 0 } } },
    })
  ).getReader();
  expect(await text(reader.read())).toBe(": connected\n\n");
  const held = reader.read();
  await root.run(dropEvents);
  wake();
  expect(await text(held)).toBe(account);
  expect((await reader.read()).done).toBe(true);
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("only the check after the rows read can stop rows of an account that signed out during it", async () => {
  const { db, wake } = handWoken();
  const reads = accountReads(["ada", "ada", null], { 2: () => wake() });
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal)],
    presets: [db, reads.auth],
  });
  const session = root.createSession({ tags: requestHeaders(new Headers()) });
  const reader = (
    await session.run(openSync, {
      input: { cursor: { public: 0, private: { accountId: "ada", revision: 0 } } },
    })
  ).getReader();
  expect(await text(reader.read())).toBe(": connected\n\n");
  const held = reader.read();
  await root.run(publish, { input: { stream: "ada", executionId: ids[0], changes: ["secret"] } });
  wake();
  expect(await text(held)).toBe(account);
  expect((await reader.read()).done).toBe(true);
  expect(reads.reads()).toBe(3);
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a sign-out that lands during the heartbeat's account read sends the account frame, not a heartbeat", async () => {
  const clock = makeTestClock();
  const { db, wake } = handWoken();
  const reads = accountReads(["ada", "ada", null], { 2: () => wake() });
  const stop = new AbortController();
  const root = createScope({
    clock,
    tags: [backendStop(stop.signal), requestStop(stop.signal)],
    presets: [db, reads.auth],
  });
  const session = root.createSession({ tags: requestHeaders(new Headers()) });
  const reader = (
    await session.run(openSync, {
      input: { cursor: { public: 0, private: { accountId: "ada", revision: 0 } } },
    })
  ).getReader();
  expect(await text(reader.read())).toBe(": connected\n\n");
  const held = reader.read();
  await settledFirst(held);
  clock.advance(10_000);
  expect(await text(held)).toBe(account);
  expect((await reader.read()).done).toBe(true);
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the stream reads the account once per wake, not once per pull", async () => {
  const { db, wake } = handWoken();
  const reads = accountReads(["ada"]);
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal)],
    presets: [db, reads.auth],
  });
  const session = root.createSession({ tags: requestHeaders(new Headers()) });
  const reader = (
    await session.run(openSync, {
      input: { cursor: { public: 0, private: { accountId: "ada", revision: 0 } } },
    })
  ).getReader();
  expect(await text(reader.read())).toBe(": connected\n\n");
  for (const [executionId, change] of [
    [ids[0], "a1"],
    [ids[1], "a2"],
  ]) {
    const held = reader.read();
    await root.run(publish, { input: { stream: "ada", executionId, changes: [change] } });
    wake();
    expect(await text(held)).toContain(`"change":"${change}"`);
  }
  expect(reads.reads()).toBe(3);
  await reader.cancel();
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a listener that breaks while it connects fails the subscribe as disconnected", async () => {
  const root = createScope({
    presets: [
      preset(database, async (_deps, { defer }) => {
        const { drizzle } = await import("drizzle-orm/pglite");
        const client = await syncTemplate.clone();
        defer(() => client.close());
        return Object.assign(drizzle({ client }), {
          listen: async (_wake: () => void, failed: () => void) => {
            failed();
            return () => undefined;
          },
        });
      }),
    ],
  });
  const feed = await root.resolve(notifications);
  await expect(feed.subscribe()).rejects.toMatchObject({ kind: "StreamDisconnected" });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a subscribe whose listener is replaced while it connects fails as disconnected", async () => {
  let feed: { subscribe(): Promise<unknown> } | undefined;
  let replacing: Promise<unknown> | undefined;
  const root = createScope({
    presets: [
      preset(database, async (_deps, { defer }) => {
        const { drizzle } = await import("drizzle-orm/pglite");
        const client = await syncTemplate.clone();
        defer(() => client.close());
        return Object.assign(drizzle({ client }), {
          listen: async (_wake: () => void, failed: () => void) => {
            if (replacing === undefined) {
              failed();
              replacing = feed?.subscribe();
            }
            return () => undefined;
          },
        });
      }),
    ],
  });
  feed = await root.resolve(notifications);
  await expect(feed.subscribe()).rejects.toMatchObject({ kind: "StreamDisconnected" });
  expect(await replacing).toMatchObject({ closed: false });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a closed subscriber is not told when the listener breaks", async () => {
  const failures: (() => void)[] = [];
  const root = createScope({
    presets: [
      preset(database, async (_deps, { defer }) => {
        const { drizzle } = await import("drizzle-orm/pglite");
        const client = await syncTemplate.clone();
        defer(() => client.close());
        return Object.assign(drizzle({ client }), {
          listen: async (_wake: () => void, failed: () => void) => {
            failures.push(failed);
            return () => undefined;
          },
        });
      }),
    ],
  });
  const feed = await root.resolve(notifications);
  let told = 0;
  const gone = await feed.subscribe(() => {
    told += 1;
  });
  feed.close(gone);
  failures[0]?.();
  expect(told).toBe(0);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a quiet stream reads the account once per heartbeat, and once more only for a wake during it", async () => {
  const clock = makeTestClock();
  const { db } = handWoken();
  const reads = accountReads(["ada", "ada", null]);
  const stop = new AbortController();
  const root = createScope({
    clock,
    tags: [backendStop(stop.signal), requestStop(stop.signal)],
    presets: [db, reads.auth],
  });
  const session = root.createSession({ tags: requestHeaders(new Headers()) });
  const reader = (
    await session.run(openSync, {
      input: { cursor: { public: 0, private: { accountId: "ada", revision: 0 } } },
    })
  ).getReader();
  expect(await text(reader.read())).toBe(": connected\n\n");
  let held = reader.read();
  await settledFirst(held);
  clock.advance(10_000);
  expect(await text(held)).toBe(": heartbeat\n\n");
  expect(reads.reads()).toBe(2);
  held = reader.read();
  await settledFirst(held);
  clock.advance(10_000);
  expect(await text(held)).toBe(account);
  expect((await reader.read()).done).toBe(true);
  expect(reads.reads()).toBe(3);
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a request whose stream was never opened ends clean", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
  });
  const session = root.createSession();
  await session.resolve(eventStream);
  expect(await session.close({ graceful: true })).toMatchObject({
    status: "success",
    teardownErrors: undefined,
  });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a private cursor resumes past revision 0", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), signedIn(new Set(["ada"]))],
  });
  const ada = root.createSession({ tags: requestHeaders(new Headers({ "x-account": "ada" })) });
  const opened = await ada.settle(openSync, {
    rawInput: { cursor: { public: 0, private: { accountId: "ada", revision: 5 } } },
  });
  if (opened.status !== "success") throw opened;
  await opened.value.cancel();
  expect((await ada.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the lease closes a client that stopped reading", async () => {
  const clock = makeTestClock();
  const stop = new AbortController();
  const root = createScope({
    clock,
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
  });
  const session = root.createSession();
  const reader = (
    await session.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();
  expect(await text(reader.read())).toBe(": connected\n\n");
  let closed = false;
  const closing = reader.closed.then(() => {
    closed = true;
  });
  clock.advance(30_000);
  for (let turn = 0; turn < 100 && !closed; turn += 1) await Promise.resolve();
  const closedBeforeReading = closed;
  await reader.cancel();
  await closing;
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(closedBeforeReading).toBe(true);
}, 30_000);

test("a heartbeat checks sign-out even when the client stopped reading", async () => {
  const clock = makeTestClock();
  const stop = new AbortController();
  const reads = accountReads(["ada", null]);
  const root = createScope({
    clock,
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
    presets: [reads.auth],
  });
  const session = root.createSession();
  const reader = (
    await session.run(openSync, {
      input: { cursor: { public: 0, private: { accountId: "ada", revision: 0 } } },
    })
  ).getReader();
  expect(await text(reader.read())).toBe(": connected\n\n");
  clock.advance(10_000);
  for (let turn = 0; turn < 100 && reads.reads() === 1; turn += 1) await Promise.resolve();
  const checkedBeforeReading = reads.reads();
  expect(await text(reader.read())).toBe(account);
  expect((await reader.read()).done).toBe(true);
  await reader.cancel();
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(checkedBeforeReading).toBe(2);
}, 30_000);

test("streams at the same cursor share one read per wake and skip the empty read after a short page", async () => {
  const queries: string[] = [];
  const { db, wake } = handWoken((query) => {
    if (query.startsWith("select") && query.includes('from "sync_event"')) queries.push(query);
  });
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
    presets: [db],
  });
  const first = root.createSession();
  const second = root.createSession();
  const cursor = { public: 0, private: null };
  const readers = await Promise.all(
    [first, second].map(async (session) =>
      (await session.run(openSync, { input: { cursor } })).getReader(),
    ),
  );
  expect(await Promise.all(readers.map((reader) => text(reader.read())))).toEqual([
    ": connected\n\n",
    ": connected\n\n",
  ]);
  const held = readers.map((reader) => reader.read());
  await root.run(publish, { input: { stream: "public", executionId: ids[0], changes: [1] } });
  wake();
  const frame = changesFrame([row("public", 1, ids[0], 1)], { public: 1, private: null });
  expect(await Promise.all(held.map(text))).toEqual([frame, frame]);
  const next = readers.map((reader) => reader.read());
  for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
  const reads = queries.length;
  await Promise.all(readers.map((reader) => reader.cancel()));
  await Promise.all(next);
  expect((await first.close({ graceful: true })).status).toBe("success");
  expect((await second.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(reads).toBe(2);
}, 30_000);

test("shared private rows keep accounts apart and check each session after sign-out", async () => {
  const { db, wake } = handWoken();
  const live = new Set(["ada-one", "ada-two", "grace"]);
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal)],
    presets: [
      db,
      preset(auth, () => ({
        handler: async () => new Response(null),
        api: {
          getSession: async ({ headers }: { headers: Headers }) => {
            const token = headers.get("x-session");
            const id = headers.get("x-account");
            return token !== null && id !== null && live.has(token) ? { user: { id } } : null;
          },
        },
      })),
    ],
  });
  const tabs = [
    { id: "ada", token: "ada-one" },
    { id: "ada", token: "ada-two" },
    { id: "grace", token: "grace" },
  ].map(({ id, token }) => ({
    id,
    session: root.createSession({
      tags: requestHeaders(new Headers({ "x-account": id, "x-session": token })),
    }),
  }));
  const readers = await Promise.all(
    tabs.map(async ({ id, session }) =>
      (
        await session.run(openSync, {
          input: { cursor: { public: 0, private: { accountId: id, revision: 0 } } },
        })
      ).getReader(),
    ),
  );
  expect(await Promise.all(readers.map((reader) => text(reader.read())))).toEqual(
    tabs.map(() => ": connected\n\n"),
  );
  live.delete("ada-one");
  await root.run(publish, {
    input: { stream: "ada", executionId: ids[0], changes: ["ada secret"] },
  });
  await root.run(publish, {
    input: { stream: "grace", executionId: ids[1], changes: ["grace secret"] },
  });
  wake();
  expect(await Promise.all(readers.map((reader) => text(reader.read())))).toEqual([
    account,
    changesFrame([row("ada", 1, ids[0], "ada secret")], {
      public: 0,
      private: { accountId: "ada", revision: 1 },
    }),
    changesFrame([row("grace", 1, ids[1], "grace secret")], {
      public: 0,
      private: { accountId: "grace", revision: 1 },
    }),
  ]);
  await Promise.all(readers.map((reader) => reader.cancel()));
  for (const { session } of tabs)
    expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
}, 30_000);

test("a failed shared row read can be retried by another open stream", async () => {
  const rename = operation({
    label: "test.renameEvents",
    input: z.boolean(),
    depends: { database },
    run: async ({ database }, { input }) => {
      const { sql } = await import("drizzle-orm");
      await database.execute(
        input
          ? sql`ALTER TABLE sync_event RENAME TO held_event`
          : sql`ALTER TABLE held_event RENAME TO sync_event`,
      );
    },
  });
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
  });
  const first = root.createSession();
  const second = root.createSession();
  const cursor = { public: 0, private: null };
  const readers = await Promise.all(
    [first, second].map(async (session) =>
      (await session.run(openSync, { input: { cursor } })).getReader(),
    ),
  );
  await root.run(rename, { input: true });
  await expect(readers[0]?.read()).rejects.toBeDefined();
  await root.run(rename, { input: false });
  const survivor = readers[1];
  if (!survivor) throw new Error("missing stream fixture");
  expect(await text(survivor.read())).toBe(": connected\n\n");
  await survivor.cancel();
  expect((await first.close({ graceful: true })).status).toBe("success");
  expect((await second.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
}, 30_000);
