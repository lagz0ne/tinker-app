import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createScope, operation } from "@tinker/core";
import { afterEach, expect, test } from "vite-plus/test";

import { authSettings, handleAuth, principal } from "~/components/auth-sqlite/index.server";
import {
  database,
  databaseBusyTimeout,
  databaseMigrationTimeout,
  databaseMigrationsFolder,
  databaseUrl,
  migrate,
  transaction,
} from "~/components/database-sqlite/index.server";
import { requestHeaders } from "~/components/requests/index.server";

const app = fileURLToPath(new URL("..", import.meta.url));

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** A migrated temp database, with auth configured for a real sign-in. */
async function sandbox() {
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

const paused = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
async function signUp(root: Sandbox, name: string, cookie = "") {
  const response = await root.run(handleAuth, {
    input: authRequest(
      "sign-up/email",
      { name, email: `${name}@example.com`, password: "safe-password-42" },
      cookie,
    ),
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

async function signOut(root: Sandbox, cookie: string) {
  const response = await root.run(handleAuth, {
    input: authRequest("sign-out", {}, cookie),
    tags: requestHeaders(new Headers({ cookie })),
  });

  return response.status;
}

/** The account a cookie signs in as, read by the component's own principal. */
async function whoIs(root: Sandbox, cookie: string) {
  const session = root.createSession({ tags: requestHeaders(new Headers({ cookie })) });

  try {
    return await session.resolve(principal);
  } finally {
    await session.close({ graceful: true });
  }
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

test("sign-up and sign-in work on an empty SQLite file, and the cookie names the account", async () => {
  const root = await sandbox();

  const first = await signUp(root, "ada");

  expect(first.id).toHaveLength(32);

  const cookie = await signIn(root, "ada");

  expect(await whoIs(root, cookie)).toMatchObject({ id: first.id, email: "ada@example.com" });

  // The first session's cookie signs in as the same account.
  expect(await whoIs(root, first.cookie)).toMatchObject({ id: first.id });

  await root.close({ graceful: true });
});

test("sign-in and sign-out each make a listener hear the session change", async () => {
  const root = await sandbox();

  const account = await signUp(root, "bea");

  const { heard, stop } = await listen(root);

  const cookie = await signIn(root, "bea");

  await until(() => heard.includes("session"));

  expect(heard.filter((payload) => payload === "session")).toHaveLength(1);

  expect(await signOut(root, cookie)).toBe(200);

  await until(() => heard.includes(`account:${account.id}`));

  expect(heard).toEqual(["session", "session", `account:${account.id}`]);

  stop();

  await root.close({ graceful: true });
});

test("sign-up creates the account's stream row once", async () => {
  const root = await sandbox();

  const account = await signUp(root, "cleo");

  const db = await root.resolve(database);

  expect(
    db.reader
      .prepare("SELECT id FROM sync_stream WHERE id = ?")
      .all(account.id)
      .map((row) => row.id),
  ).toEqual([account.id]);

  await root.close({ graceful: true });
});

test("a sign-up waits for an open session transaction, and outlives its rollback", async () => {
  const root = await sandbox();

  const db = await root.resolve(database);

  const inside = Promise.withResolvers<void>();

  const gate = Promise.withResolvers<void>();

  const holding = operation({
    label: "proof.authHold",
    depends: { tx: transaction },
    run: async ({ tx }, { raise }) => {
      await tx.notify("proof", "held");

      inside.resolve();

      await gate.promise;

      raise("StepRefused", {});
    },
  });

  const held = root.settle(holding, { signal: new AbortController().signal });

  await inside.promise;

  const signing = signUp(root, "dana");

  // The write turn is held, so Better Auth's checkout waits and writes nothing yet.
  await paused(300);

  expect(db.reader.prepare("SELECT id FROM user").all()).toEqual([]);

  gate.resolve();

  await expect(held).resolves.toMatchObject({ status: "failed", error: { kind: "StepRefused" } });

  const account = await signing;

  expect(
    db.reader
      .prepare("SELECT id FROM user")
      .all()
      .map((row) => row.id),
  ).toEqual([account.id]);

  // The rolled-back call left no notice of its own: the sign-up's session notice is all there is.
  expect(
    db.reader
      .prepare("SELECT payload FROM start_notify")
      .all()
      .map((row) => row.payload),
  ).toEqual(["session"]);

  await root.close({ graceful: true });
});
