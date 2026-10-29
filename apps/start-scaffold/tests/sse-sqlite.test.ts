import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createScope, operation } from "@tinker/core";
import { afterEach, expect, test } from "vite-plus/test";

import {
  authSettings,
  authStartup,
  handleAuth,
  openSync,
} from "~/components/auth-sqlite/index.server";
import {
  databaseBusyTimeout,
  databaseMigrationTimeout,
  databaseMigrationsFolder,
  databasePollInterval,
  databaseUrl,
  migrate,
  transaction,
} from "~/components/database-sqlite/index.server";
import { backendStop as requestHostStop } from "~/components/requests";
import { backendStop, requestStop, startRequests } from "~/components/requests";
import { requestHeaders } from "~/components/requests/index.server";
import { eventHistory, notifications } from "~/components/sync-sqlite/index.server";
import type { Sync } from "~/components/sync-sqlite/index.server";

import { write } from "./write-boundary";

const app = fileURLToPath(new URL("..", import.meta.url));

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const settings = authSettings({
  origin: "http://localhost:4318",
  secret: "test-secret-with-at-least-thirty-two-letters",
});

/** A migrated temp SQLite file, and the tags a server root over it binds. */
async function sqliteFile() {
  const home = await mkdtemp(join(tmpdir(), "tinker-sse-sqlite-"));

  homes.push(home);

  const folder = join(home, "migrations");

  await mkdir(folder);

  for (const name of await readdir(join(app, "sqlite/migrations"))) {
    await writeFile(
      join(folder, name),
      await readFile(join(app, "sqlite/migrations", name), "utf8"),
    );
  }

  return [
    databaseUrl(pathToFileURL(join(home, "app.db"))),
    databaseMigrationsFolder(folder),
    databaseBusyTimeout(1000),
    databaseMigrationTimeout(10_000),
    databasePollInterval(40),
  ];
}

/** A server root with auth and requests, stopped by `stop`, over a fresh migrated file. */
async function server(stop: AbortController, headers?: Headers) {
  const root = createScope({
    extensions: [startRequests, authStartup],
    signal: stop.signal,
    tags: [
      requestHostStop(new AbortController().signal),
      [
        ...(await sqliteFile()),
        settings,
        backendStop(stop.signal),
        requestStop(stop.signal),
        ...(headers ? [requestHeaders(headers)] : []),
      ],
    ],
  });

  await root.ready;
  await root.run(migrate);

  return root;
}

/** One call's write: lock the stream, append the payloads, and end. */
function save(owner: string, payloads: Sync.Payload[]) {
  return operation({
    label: "proof.sseSave",
    depends: { tx: transaction, history: eventHistory },
    run: async ({ tx, history }) => {
      await history.lock(tx, owner);
      await history.append(tx, owner, crypto.randomUUID(), payloads);
    },
  });
}

/** The same write, refused after the append, so the call rolls back. */
const rollBackEvent = operation({
  label: "proof.sseRollback",
  depends: { tx: transaction, history: eventHistory },
  run: async ({ tx, history }, { raise }) => {
    await history.lock(tx, "public");
    await history.append(tx, "public", crypto.randomUUID(), [{ kind: "change", change: 99 }]);

    raise("Rollback", {});
  },
});

const counter = (value: number): Sync.Payload[] => [
  { kind: "change", change: { kind: "counter", value } },
  { kind: "result", result: { kind: "complete", value } },
];

function signup(name: string) {
  return new Request("http://localhost:4318/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:4318" },
    body: JSON.stringify({ name, email: `${name}@example.com`, password: "safe-password-42" }),
  });
}

/** The cookie a sign-up response sets, and the account it made. */
async function signedUp(root: Awaited<ReturnType<typeof server>>, name: string) {
  const response = await root.run(handleAuth, {
    input: signup(name),
    tags: requestHeaders(new Headers()),
  });

  const body = (await response.json()) as { user: { id: string } };

  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";").at(0))
    .join("; ");

  return { id: body.user.id, headers: new Headers({ cookie }) };
}

function signOut(root: Awaited<ReturnType<typeof server>>, headers: Headers) {
  return root.run(handleAuth, {
    tags: requestHeaders(headers),
    input: new Request("http://localhost:4318/api/auth/sign-out", {
      method: "POST",
      headers: new Headers([...headers, ["origin", "http://localhost:4318"]]),
    }),
  });
}

const text = (chunk: ReadableStreamReadResult<Uint8Array>) => new TextDecoder().decode(chunk.value);

test("SQLite notifications wake after commit, stay silent on rollback, and survive a read before waiting", async () => {
  const stop = new AbortController();
  const root = await server(stop);

  try {
    const feed = await root.resolve(notifications);
    const subscription = await feed.subscribe();
    const before = feed.revision();

    const refused = await root.settle(rollBackEvent, { signal: new AbortController().signal });

    expect(refused).toMatchObject({ status: "failed", error: { kind: "Rollback" } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(feed.revision()).toBe(before);

    await write(root, save("public", counter(1)));
    await feed.wait(subscription, before);
    expect(feed.revision()).toBeGreaterThan(before);

    feed.close(subscription);
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("SSE replays the supplied cursor and a held reader receives the next committed batch", async () => {
  const stop = new AbortController();
  const root = await server(stop, new Headers());

  try {
    await write(root, save("public", counter(1)));

    const response = await root.run(openSync, {
      input: { cursor: { public: 0, private: null } },
    });
    const reader = response.getReader();

    const first = text(await reader.read());

    expect(first).toMatch(/^event: changes\nid: \{"public":2,"private":null\}\ndata: /);
    expect(first).toContain('"value":1');
    expect(first.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(first.split("\ndata: ").at(1) ?? "")).toEqual({
      kind: "changes",
      events: [
        {
          stream: "public",
          revision: 1,
          executionId: expect.any(String),
          payload: counter(1)[0],
        },
        {
          stream: "public",
          revision: 2,
          executionId: expect.any(String),
          payload: counter(1)[1],
        },
      ],
    });
    expect(text(await reader.read())).toBe(": connected\n\n");

    const waiting = reader.read();

    await write(root, save("public", counter(2)));
    expect(text(await waiting)).toContain('"value":2');

    const idle = reader.read();

    await reader.cancel();
    expect((await idle).done).toBe(true);

    const openingStop = new AbortController();
    const openingRequest = root.createSession({ tags: requestStop(openingStop.signal) });
    const opening = openingRequest.settle(openSync, {
      input: { cursor: { public: 4, private: null } },
    });

    openingStop.abort();
    expect(await opening).toMatchObject({ status: "failed", error: { kind: "Cancelled" } });
    expect((await openingRequest.close({ graceful: true })).status).toBe("success");
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("a reconnect cursor wins over the query cursor, and a bad cursor is refused", async () => {
  const stop = new AbortController();
  const root = await server(stop, new Headers());

  /** The first chunk a request with these stream inputs reads, from its own session. */
  async function firstChunk(raw: { search: string; lastEventId: string | null }) {
    const session = root.createSession();
    const reader = (await session.run(openSync, { rawInput: raw })).getReader();

    try {
      return text(await reader.read());
    } finally {
      await reader.cancel();
      await session.close({ graceful: true });
    }
  }

  const query = (cursor: object) => `?cursor=${encodeURIComponent(JSON.stringify(cursor))}`;

  try {
    await write(root, save("public", counter(1)));
    await write(root, save("public", counter(2)));

    const resumed = await firstChunk({
      lastEventId: JSON.stringify({ public: 2, private: null }),
      search: query({ public: 0, private: null }),
    });

    expect(resumed).toContain('id: {"public":4,"private":null}');
    expect(resumed).not.toContain('"value":1');

    const searched = await firstChunk({
      search: query({ public: 2, private: null }),
      lastEventId: null,
    });

    expect(searched).toContain('id: {"public":4,"private":null}');
    expect(searched).not.toContain('"value":1');

    const fresh = await firstChunk({ search: "", lastEventId: null });

    expect(fresh).toContain('"value":1');

    const refused = await root.settle(openSync, {
      rawInput: { search: query({ public: -1, private: null }), lastEventId: null },
      signal: new AbortController().signal,
    });

    expect(refused.status).toBe("failed");
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("private SSE cursors are refused and a revoked held stream sends no saved private rows", async () => {
  const stop = new AbortController();
  const root = await server(stop);

  try {
    const ada = await signedUp(root, "Ada");
    const grace = await signedUp(root, "Grace");
    const cursor = { public: 0, private: { accountId: ada.id, revision: 0 } };

    const other = root.createSession({ tags: requestHeaders(grace.headers) });
    const refused = await other.settle(openSync, { input: { cursor } });

    expect(refused).toMatchObject({ status: "failed", error: { kind: "StreamDenied" } });
    await other.close();

    const owner = root.createSession({ tags: requestHeaders(ada.headers) });
    const response = await owner.run(openSync, { input: { cursor } });

    await write(root, save(ada.id, [{ kind: "change", change: "Never sent after revocation" }]));
    await signOut(root, ada.headers);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const reader = response.getReader();

    expect(text(await reader.read())).toBe('event: account\ndata: {"kind":"account-change"}\n\n');
    expect((await reader.read()).done).toBe(true);
    expect((await owner.close({ graceful: true })).status).toBe("success");
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("a private stream replays its own rows after the public ones, with both cursors", async () => {
  const stop = new AbortController();
  const root = await server(stop);

  try {
    const ada = await signedUp(root, "Ada");

    await write(root, save("public", counter(1)));
    await write(root, save(ada.id, [{ kind: "change", change: "mine" }]));

    const owner = root.createSession({ tags: requestHeaders(ada.headers) });
    const response = await owner.run(openSync, {
      input: { cursor: { public: 0, private: { accountId: ada.id, revision: 0 } } },
    });
    const reader = response.getReader();
    const frame = text(await reader.read());

    expect(frame).toContain(`id: {"public":2,"private":{"accountId":"${ada.id}","revision":1}}`);
    expect(
      (JSON.parse(frame.split("\ndata: ").at(1) ?? "") as { events: Sync.Event[] }).events.map(
        (event) => [event.stream, event.revision],
      ),
    ).toEqual(
      // The read orders by stream name, then revision, as SQLite compares the bytes.
      [
        [ada.id, 1],
        ["public", 1],
        ["public", 2],
      ].sort(([left], [right]) => (left === right ? 0 : String(left) < String(right) ? -1 : 1)),
    );
    expect(text(await reader.read())).toBe(": connected\n\n");

    await reader.cancel();
    expect((await owner.close({ graceful: true })).status).toBe("success");
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("two accounts at the same public cursor each read only their own private rows", async () => {
  const stop = new AbortController();
  const root = await server(stop);

  try {
    const ada = await signedUp(root, "Ada");
    const grace = await signedUp(root, "Grace");

    await write(root, save(ada.id, [{ kind: "change", change: "for Ada" }]));
    await write(root, save(grace.id, [{ kind: "change", change: "for Grace" }]));

    const opened = [];

    for (const account of [ada, grace]) {
      const session = root.createSession({ tags: requestHeaders(account.headers) });
      const reader = (
        await session.run(openSync, {
          input: { cursor: { public: 0, private: { accountId: account.id, revision: 0 } } },
        })
      ).getReader();

      opened.push({ session, reader, frame: text(await reader.read()) });
    }

    expect(opened.map(({ frame }) => frame.includes("for Ada"))).toEqual([true, false]);
    expect(opened.map(({ frame }) => frame.includes("for Grace"))).toEqual([false, true]);

    for (const { session, reader } of opened) {
      await reader.cancel();
      expect((await session.close({ graceful: true })).status).toBe("success");
    }
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("a quiet private stream closes at once on sign-out, with no heartbeat", async () => {
  const stop = new AbortController();
  const root = await server(stop);

  try {
    const ada = await signedUp(root, "Ada");

    const owner = root.createSession({ tags: requestHeaders(ada.headers) });
    const response = await owner.run(openSync, {
      input: { cursor: { public: 0, private: { accountId: ada.id, revision: 0 } } },
    });

    const reader = response.getReader();

    expect(text(await reader.read())).toBe(": connected\n\n");

    const waiting = reader.read();

    await signOut(root, ada.headers);

    expect(text(await waiting)).toBe('event: account\ndata: {"kind":"account-change"}\n\n');
    expect((await reader.read()).done).toBe(true);
    expect((await owner.close({ graceful: true })).status).toBe("success");
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("auth startup rejects ready without its settings, and starts with them", async () => {
  const missing = createScope({ extensions: [authStartup] });

  await expect(missing.ready).rejects.toMatchObject({
    kind: "MissingTag",
    payload: { label: "auth.settings" },
  });
  expect((await missing.close({ graceful: true })).status).toBe("failed");

  const ready = createScope({ extensions: [authStartup], tags: [settings] });

  await ready.ready;
  expect((await ready.close({ graceful: true })).status).toBe("success");
});
