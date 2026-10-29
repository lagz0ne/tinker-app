import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createScope } from "@tinker/core";
import { sql } from "kysely";
import { afterEach, expect, test } from "vite-plus/test";

import {
  auth,
  authSettings,
  handleAuth,
  liveAccount,
  principal,
} from "~/components/auth-sqlite/index.server";
import {
  database,
  databaseBusyTimeout,
  databaseMigrationTimeout,
  databaseMigrationsFolder,
  databaseUrl,
  migrate,
} from "~/components/database-sqlite/index.server";
import { requestHeaders } from "~/components/requests/index.server";

const app = fileURLToPath(new URL("..", import.meta.url));

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

type Logged = { message: string; attributes?: unknown };

/** A migrated temp database, with auth configured for a real sign-in and its logs kept. */
async function sandbox(logs: Logged[] = []) {
  const home = await mkdtemp(join(tmpdir(), "tinker-auth-sqlite-"));

  homes.push(home);

  const folder = join(home, "migrations");

  await mkdir(folder);

  for (const name of await readdir(join(app, "sqlite/migrations"))) {
    await writeFile(
      join(folder, name),
      await readFile(join(app, "sqlite/migrations", name), "utf8"),
    );
  }

  const root = createScope({
    observe: { log: (entry) => logs.push(entry) },
    tags: [
      databaseUrl(pathToFileURL(join(home, "app.db"))),
      databaseMigrationsFolder(folder),
      databaseBusyTimeout(20),
      databaseMigrationTimeout(10_000),
      authSettings({
        origin: "http://localhost:4318",
        secret: "test-secret-with-at-least-thirty-two-letters",
      }),
    ],
  });

  await root.run(migrate);

  return root;
}

type Sandbox = Awaited<ReturnType<typeof sandbox>>;

/** Wait until `ready` holds, or fail here instead of at the test timeout. */
async function until(ready: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (ready()) return;

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`not ready after ${ms}ms`);
}

function authRequest(path: string, body: object, cookie = "") {
  return new Request(`http://localhost:4318/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:4318", cookie },
    body: JSON.stringify(body),
  });
}

function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";").at(0))
    .join("; ");
}

/** A signed-up account, with the cookie of its first session and its account ID. */
async function signUp(root: Sandbox, name: string) {
  const response = await root.run(handleAuth, {
    input: authRequest("sign-up/email", {
      name,
      email: `${name}@example.com`,
      password: "safe-password-42",
    }),
    tags: requestHeaders(new Headers()),
  });

  const body = (await response.json()) as { user: { id: string } };

  return { id: body.user.id, cookie: cookieOf(response) };
}

async function signIn(root: Sandbox, name: string) {
  const response = await root.run(handleAuth, {
    input: authRequest("sign-in/email", {
      email: `${name}@example.com`,
      password: "safe-password-42",
    }),
    tags: requestHeaders(new Headers()),
  });

  return cookieOf(response);
}

/** A listener on the sync channel, with what it has heard so far. */
async function listen(root: Sandbox) {
  const db = await root.resolve(database);

  const heard: string[] = [];

  const stop = await db.listen(
    "start_sync",
    (payload) => heard.push(payload),
    () => heard.push("disconnected"),
  );

  return { heard, stop };
}

function streamRows(root: Sandbox, id: string) {
  return root
    .resolve(database)
    .then((db) => db.reader.prepare("SELECT id FROM sync_stream WHERE id = ?").all(id).length);
}

test("principal and the live account read the cookie's account, or null without one", async () => {
  const root = await sandbox();

  const account = await signUp(root, "ivy");

  const anonymous = root.createSession({ tags: requestHeaders(new Headers()) });

  try {
    expect(await anonymous.resolve(principal)).toBeNull();
  } finally {
    await anonymous.close({ graceful: true });
  }

  expect(
    await root.run(liveAccount, {
      tags: requestHeaders(new Headers({ cookie: account.cookie })),
    }),
  ).toBe(account.id);
  expect(await root.run(liveAccount, { tags: requestHeaders(new Headers()) })).toBeNull();

  await root.close({ graceful: true });
});

test("an account made without a session still gets its stream", async () => {
  const root = await sandbox();

  const context = await (await root.resolve(auth)).$context;

  const user = await context.internalAdapter.createUser(
    {
      name: "Jo",
      email: "jo@example.com",
      emailVerified: false,
    },
    { method: "admin" },
  );

  expect(await streamRows(root, user.id)).toBe(1);

  await root.close({ graceful: true });
});

test("a refused stream is logged, and the account is still made", async () => {
  const logs: Logged[] = [];

  const root = await sandbox(logs);

  const db = await root.resolve(database);

  db.client.exec(
    "CREATE TRIGGER proof_refuse_stream BEFORE INSERT ON sync_stream BEGIN SELECT RAISE(ABORT, 'stream refused'); END",
  );

  const context = await (await root.resolve(auth)).$context;

  const user = await context.internalAdapter.createUser(
    {
      name: "Kai",
      email: "kai@example.com",
      emailVerified: false,
    },
    { method: "admin" },
  );

  expect(db.reader.prepare("SELECT id FROM user WHERE id = ?").all(user.id)).toHaveLength(1);
  expect(logs.filter((entry) => entry.message === "auth.accountStreamFailed")).toMatchObject([
    { attributes: { accountId: user.id } },
  ]);

  await root.close({ graceful: true });
});

test("a sign-in brings back an account stream that is gone", async () => {
  const root = await sandbox();

  const account = await signUp(root, "lou");

  const db = await root.resolve(database);

  db.client.prepare("DELETE FROM sync_stream WHERE id = ?").run(account.id);

  expect(await streamRows(root, account.id)).toBe(0);

  await signIn(root, "lou");

  expect(await streamRows(root, account.id)).toBe(1);

  await root.close({ graceful: true });
});

test("a session update makes a listener hear the session change", async () => {
  const root = await sandbox();

  await signUp(root, "max");

  const db = await root.resolve(database);

  const token = String(db.reader.prepare('SELECT token FROM "session"').get()?.token);

  const { heard, stop } = await listen(root);

  const context = await (await root.resolve(auth)).$context;

  await context.internalAdapter.updateSession(token, { updatedAt: new Date() });

  await until(() => heard.includes("session"));

  expect(heard).toEqual(["session"]);

  stop();

  await root.close({ graceful: true });
});

test("the browser renews its session through a POST to get-session", async () => {
  const root = await sandbox();

  const account = await signUp(root, "nia");

  const response = await root.run(handleAuth, {
    input: authRequest("get-session", {}, account.cookie),
    tags: requestHeaders(new Headers({ cookie: account.cookie })),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ user: { id: account.id } });

  await root.close({ graceful: true });
});

test("auth's own Kysely runs its transactions on the write connection", async () => {
  const root = await sandbox();

  const db = await root.resolve(database);

  const instance = await root.resolve(auth);

  const kysely = instance.options.database.db;

  const insert = (id: string) =>
    sql`insert into verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
      values (${id}, 'proof', ${id}, '2030-01-01', '2030-01-01', '2030-01-01')`;

  const inside: boolean[] = [];

  await kysely.transaction().execute(async (trx) => {
    await insert("kept").execute(trx);

    inside.push(db.client.isTransaction);
  });

  await expect(
    kysely.transaction().execute(async (trx) => {
      await insert("dropped").execute(trx);

      throw new Error("refused");
    }),
  ).rejects.toThrow("refused");

  // BEGIN ran inside, and both ends left the shared connection outside any transaction.
  expect(inside).toEqual([true]);
  expect(db.client.isTransaction).toBe(false);
  expect(
    db.reader
      .prepare("SELECT id FROM verification ORDER BY id")
      .all()
      .map((entry) => entry.id),
  ).toEqual(["kept"]);

  // Better Auth's schema tools read the file through the same Kysely.
  expect((await kysely.introspection.getTables()).map((table) => table.name)).toContain("user");

  await root.close({ graceful: true });
});

test("auth carries Start's cookie plugin, so server calls set cookies on the reply", async () => {
  const root = await sandbox();

  const instance = await root.resolve(auth);

  expect(instance.options.plugins.map((plugin) => plugin.id)).toEqual(["tanstack-start-cookies"]);

  await root.close({ graceful: true });
});
