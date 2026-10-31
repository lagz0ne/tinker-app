import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { createScope } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { liveAccount } from "~/components/auth-sqlite/index.server";
import { openSync } from "~/components/auth-sqlite/index.server";
import { database, databaseUrl } from "~/components/database-sqlite/index.server";
import { backendStop, requestStop, startRequests } from "~/components/requests";
import { requestHeaders } from "~/components/requests/index.server";
import { notifications } from "~/components/sync-sqlite/notifications.server";

import { handWoken } from "./fixtures/sync-sqlite";

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
      tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
      presets: [
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
    hand.notice(root, "Ada");
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
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
    presets: [hand.db, preset(liveAccount, async () => null)],
  });

  await root.ready;
  const first = root.createSession();
  const body = await first.run(openSync, { input: { cursor: { public: 0, private: null } } });
  expect(queries.filter((query) => query.includes("from sync_event"))).toEqual([]);
  await body.cancel();
  expect((await first.close({ graceful: true })).status).toBe("success");
  const next = root.createSession();
  const reader = (
    await next.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
  expect(queries.filter((query) => query.includes("from sync_event"))).toHaveLength(1);
  await reader.cancel();
  expect((await next.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a quiet stream sends a heartbeat each lease tick and ends when its lease runs out", async () => {
  const clock = makeTestClock();
  const hand = handWoken();
  const stop = new AbortController();
  const root = createScope({
    clock,
    extensions: [startRequests],
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
    presets: [hand.db, preset(liveAccount, async () => null)],
  });

  await root.ready;

  const session = root.createSession();
  const reader = (
    await session.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();

  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");

  const beat = reader.read();

  clock.advance(10_000);
  expect(new TextDecoder().decode((await beat).value)).toBe(": heartbeat\n\n");

  const again = reader.read();

  clock.advance(10_000);
  expect(new TextDecoder().decode((await again).value)).toBe(": heartbeat\n\n");

  // The 30 second lease ends the stream instead of sending a third heartbeat.
  const last = reader.read();

  clock.advance(10_000);
  expect(await last).toEqual({ value: undefined, done: true });

  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the hand-woken file opens both connections as the component does, so a commit waits on no disk sync", async () => {
  const home = await mkdtemp(join(tmpdir(), "tinker-stream-sqlite-"));
  const real = createScope({ tags: [databaseUrl(pathToFileURL(join(home, "app.db")))] });
  const fixture = createScope({ presets: [handWoken().db] });

  const settings = (connection: DatabaseSync) =>
    ["journal_mode", "synchronous", "busy_timeout", "foreign_keys"].map(
      (name) => Object.values(connection.prepare(`PRAGMA ${name}`).get() ?? {})[0],
    );

  try {
    const component = await real.resolve(database);
    const hand = await fixture.resolve(database);

    // Rollback journal with FULL sync costs several disk syncs per commit; under disk load
    // the 150-row backlog below then outlasts the test timeout.
    expect(settings(hand.client)).toEqual(settings(component.client));
    expect(settings(hand.reader)).toEqual(settings(component.reader));
  } finally {
    await fixture.close({ graceful: true });
    await real.close({ graceful: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("a backlog past one page is sent as full pages before the stream says it is connected", async () => {
  const hand = handWoken();
  const stop = new AbortController();
  const root = createScope({
    extensions: [startRequests],
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
    presets: [hand.db, preset(liveAccount, async () => null)],
  });

  await root.ready;

  const db = await root.resolve(database);
  const insert = db.client.prepare(
    "INSERT INTO sync_event (stream, revision, execution_id, payload) VALUES ('public', ?, ?, ?)",
  );

  for (let revision = 1; revision <= 150; revision += 1) {
    insert.run(revision, "execution", JSON.stringify({ kind: "change", change: revision }));
  }

  const session = root.createSession();
  const reader = (
    await session.run(openSync, { input: { cursor: { public: 0, private: null } } })
  ).getReader();

  const pages = [
    new TextDecoder().decode((await reader.read()).value),
    new TextDecoder().decode((await reader.read()).value),
  ];

  expect(pages.map((page) => page.split("\n").at(1))).toEqual([
    'id: {"public":100,"private":null}',
    'id: {"public":150,"private":null}',
  ]);
  expect(
    pages.map(
      (page) => (JSON.parse(page.split("\ndata: ").at(1) ?? "") as { events: unknown[] }).events,
    ),
  ).toMatchObject([{ length: 100 }, { length: 50 }]);
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");

  await reader.cancel();
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

/** A root over a hand-woken SQLite file whose live account is `account`. */
async function streamRoot(hand: ReturnType<typeof handWoken>, account: string | null = null) {
  const stop = new AbortController();
  const root = createScope({
    extensions: [startRequests],
    tags: [backendStop(stop.signal), requestStop(stop.signal), requestHeaders(new Headers())],
    presets: [hand.db, preset(liveAccount, async () => account)],
  });

  await root.ready;

  const db = await root.resolve(database);
  const insert = db.client.prepare(
    "INSERT INTO sync_event (stream, revision, execution_id, payload) VALUES (?, ?, ?, ?)",
  );

  /** Open a public-only stream at `from` in its own session. */
  const open = async (from = 0) => {
    const session = root.createSession();
    const body = await session.run(openSync, {
      input: { cursor: { public: from, private: null } },
    });

    return { session, reader: body.getReader() };
  };

  return {
    root,
    open,
    row: (revision: number) =>
      insert.run(
        "public",
        revision,
        "execution",
        JSON.stringify({ kind: "change", change: revision }),
      ),
  };
}

test("a signed-in account on a public-only stream gets the account change at once", async () => {
  const hand = handWoken();
  const { root, open } = await streamRoot(hand, "Ada");
  const { session, reader } = await open();

  expect(new TextDecoder().decode((await reader.read()).value)).toBe(
    'event: account\ndata: {"kind":"account-change"}\n\n',
  );
  expect((await reader.read()).done).toBe(true);
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a stream opened after a wake still replays the rows behind its cursor", async () => {
  const hand = handWoken();
  const { root, open, row } = await streamRoot(hand);
  const first = await open();

  row(1);
  hand.wake();

  const second = await open();

  expect(new TextDecoder().decode((await second.reader.read()).value)).toContain(
    'id: {"public":1,"private":null}',
  );

  for (const stream of [first, second]) {
    await stream.reader.cancel();
    expect((await stream.session.close({ graceful: true })).status).toBe("success");
  }

  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a stream that changes its frame bytes does not change another stream's copy", async () => {
  const hand = handWoken();
  const { root, open, row } = await streamRoot(hand);

  row(1);

  const streams = [await open(), await open()];
  const first = (await streams[0]!.reader.read()).value;

  first?.fill(0);

  expect(new TextDecoder().decode((await streams[1]!.reader.read()).value)).toContain(
    'id: {"public":1,"private":null}',
  );

  for (const stream of streams) {
    await stream.reader.cancel();
    expect((await stream.session.close({ graceful: true })).status).toBe("success");
  }

  expect((await root.close({ graceful: true })).status).toBe("success");
});
