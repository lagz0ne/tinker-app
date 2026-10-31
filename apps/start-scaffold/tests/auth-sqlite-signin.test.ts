import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createScope } from "@tinker/core";
import { makeTestClock } from "@tinker/core/testing";
import { afterEach, expect, test } from "vite-plus/test";

import {
  approveSignin,
  authSettings,
  endSignin,
  handleAuth,
  listSignins,
  mcpCaller,
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

const origin = "http://localhost:4318";

const chrome =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** A migrated temp database, with auth configured and a clock the test moves. */
async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), "tinker-auth-signin-"));

  homes.push(home);

  const folder = join(home, "migrations");

  await mkdir(folder);

  for (const name of await readdir(join(app, "sqlite/migrations"))) {
    await writeFile(
      join(folder, name),
      await readFile(join(app, "sqlite/migrations", name), "utf8"),
    );
  }

  const clock = makeTestClock({ now: Date.now() });

  const root = createScope({
    clock,
    tags: [
      databaseUrl(pathToFileURL(join(home, "app.db"))),
      databaseMigrationsFolder(folder),
      databaseBusyTimeout(20),
      databaseMigrationTimeout(10_000),
      authSettings({ origin, secret: "test-secret-with-at-least-thirty-two-letters" }),
    ],
  });

  await root.run(migrate);

  const db = await root.resolve(database);

  return { root, clock, db };
}

type Sandbox = Awaited<ReturnType<typeof sandbox>>;

/** One request through the component's auth mount, as the route hands it over. */
function send(box: Sandbox, path: string, init: { body?: object; cookie?: string } = {}) {
  const headers = new Headers({ origin, "user-agent": chrome, cookie: init.cookie ?? "" });

  if (init.body) headers.set("content-type", "application/json");

  return box.root.run(handleAuth, {
    input: new Request(`${origin}/api/auth/${path}`, {
      method: init.body ? "POST" : "GET",
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    }),
    tags: requestHeaders(headers),
  });
}

function cookieOf(response: Response, name: string) {
  return (
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${name}=`))
      ?.split(";")
      .at(0) ?? ""
  );
}

function sessionCookie(response: Response) {
  return cookieOf(response, "better-auth.session_token");
}

async function signUp(box: Sandbox, name: string) {
  const response = await send(box, "sign-up/email", {
    body: { name, email: `${name}@example.com`, password: "safe-password-42" },
  });

  const body = (await response.json()) as { user: { id: string } };

  return { id: body.user.id, cookie: sessionCookie(response), clientId: `client-${name}` };
}

type Person = Awaited<ReturnType<typeof signUp>>;

/** A browser asks for a code: the shown code, the device cookie, and the reply. */
async function start(box: Sandbox, body: object = {}) {
  const response = await send(box, "signin/code", { body });

  const json = (await response.json()) as { user_code: string; expires_in: number };

  return { response, json, code: json.user_code, device: cookieOf(response, "tinker_device") };
}

async function stateOf(box: Sandbox, cookie: string) {
  return ((await (await send(box, "signin/code/state", { cookie })).json()) as { state: string })
    .state;
}

function finish(box: Sandbox, cookie: string, body: object = {}) {
  return send(box, "signin/code/finish", { body, cookie });
}

function approve(box: Sandbox, who: Person, code: string) {
  return box.root.run(approveSignin, {
    input: { code },
    tags: mcpCaller({ userId: who.id, clientId: who.clientId, scopes: ["mcp"] }),
  });
}

function list(box: Sandbox, who: Person) {
  return box.root.run(listSignins, {
    input: {},
    tags: mcpCaller({ userId: who.id, clientId: who.clientId, scopes: ["mcp"] }),
  });
}

function end(box: Sandbox, who: Person, id: string) {
  return box.root.run(endSignin, {
    input: { id },
    tags: mcpCaller({ userId: who.id, clientId: who.clientId, scopes: ["mcp"] }),
  });
}

function refused(message: RegExp | string) {
  return { kind: "Refused", payload: { message: expect.stringMatching(message) } };
}

async function whoIs(box: Sandbox, cookie: string) {
  const session = box.root.createSession({ tags: requestHeaders(new Headers({ cookie })) });

  try {
    return await session.resolve(principal);
  } finally {
    await session.close({ graceful: true });
  }
}

function deviceRows(box: Sandbox) {
  return box.db.reader
    .prepare(`SELECT deviceCode, userCode, userId, status, expiresAt FROM "deviceCode"`)
    .all() as { deviceCode: string; userCode: string; userId: string | null; status: string }[];
}

/** Move a code's end into the past, as Better Auth's own clock would see it later. */
function expire(box: Sandbox, userCode: string) {
  box.db.client
    .prepare(`UPDATE "deviceCode" SET expiresAt = ? WHERE userCode = ?`)
    .run(new Date(Date.now() - 1000).toISOString(), userCode.replace("-", ""));
}

const shape = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

test("A1: start answers a code and sets the device cookie; the device half is in no body", async () => {
  const box = await sandbox();

  const { response, json, device } = await start(box);

  expect(response.status).toBe(200);

  expect(json).toEqual({ user_code: expect.stringMatching(shape), expires_in: 600 });

  expect(response.headers.get("cache-control")).toBe("no-store");

  const set = response.headers.getSetCookie().find((value) => value.startsWith("tinker_device="));

  expect(set).toMatch(/^tinker_device=[^;]{30,};/);

  expect(set).toMatch(/; HttpOnly/i);

  expect(set).toMatch(/; SameSite=Lax/i);

  expect(set).toMatch(/; Path=\//);

  expect(set).toMatch(/; Max-Age=600/);

  expect(set).not.toMatch(/; Secure/i);

  const half = device.split("=")[1];

  expect(JSON.stringify(json)).not.toContain(half);

  expect(deviceRows(box)).toEqual([
    {
      deviceCode: half,
      userCode: json.user_code.replace("-", ""),
      userId: null,
      status: "pending",
      expiresAt: expect.any(String),
    },
  ]);

  await box.root.close({ graceful: true });
});

test("A2: with 50 codes waiting a start answers 429 slow_down; expired codes do not count", async () => {
  const box = await sandbox();

  const first = await start(box);

  for (let i = 1; i < 50; i++) await start(box);

  const full = await send(box, "signin/code", { body: {} });

  expect(full.status).toBe(429);

  expect(await full.json()).toMatchObject({
    error: "slow_down",
    error_description: expect.stringMatching(/Too many codes wait/),
  });

  expect(deviceRows(box)).toHaveLength(50);

  expire(box, first.code);

  expect((await send(box, "signin/code", { body: {} })).status).toBe(200);

  expect(deviceRows(box)).toHaveLength(51);

  await box.root.close({ graceful: true });
});

test("A3, A4: state is waiting with the cookie; gone with no cookie, a wrong one, or after expiry", async () => {
  const box = await sandbox();

  const { code, device } = await start(box);

  expect(await stateOf(box, device)).toBe("waiting");

  expect(await stateOf(box, "")).toBe("gone");

  expect(await stateOf(box, "tinker_device=not-a-real-device-half-at-all-0000")).toBe("gone");

  // Another browser that only knows the user code gets nothing.
  expect(await stateOf(box, `tinker_device=${code}`)).toBe("gone");

  const state = await send(box, "signin/code/state", { cookie: device });

  expect(state.headers.get("cache-control")).toBe("no-store");

  expire(box, code);

  expect(await stateOf(box, device)).toBe("gone");

  await box.root.close({ graceful: true });
});

test("A5, A6: an approve takes the code in any case and spacing; a second approve is refused", async () => {
  const box = await sandbox();

  const u = await signUp(box, "ursa");

  const v = await signUp(box, "vale");

  const { code, device } = await start(box);

  const typed = `${code.slice(0, 4).toLowerCase()} ${code.slice(5).toLowerCase()}`;

  const done = await approve(box, u, typed);

  expect(done.text).toMatch(
    new RegExp(`^Approved code ${code} \\(Chrome on Mac, sign-in, asked at \\d\\d:\\d\\d UTC\\)`),
  );

  expect(deviceRows(box)).toMatchObject([{ status: "approved", userId: u.id }]);

  expect(await stateOf(box, device)).toBe("approved");

  await expect(approve(box, u, code)).rejects.toMatchObject(
    refused(`Code ${code} is already approved.`),
  );

  await expect(approve(box, v, code)).rejects.toMatchObject(
    refused(`Code ${code} is already approved.`),
  );

  expect(deviceRows(box)).toMatchObject([{ status: "approved", userId: u.id }]);

  await box.root.close({ graceful: true });
});

test("A7: of two approves of one code at once, one wins and the row names the winner", async () => {
  const box = await sandbox();

  const u = await signUp(box, "ursa");

  const v = await signUp(box, "vale");

  const { code } = await start(box);

  const [left, right] = await Promise.allSettled([approve(box, u, code), approve(box, v, code)]);

  const results = [left, right];

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

  const lost = results.find((result) => result.status === "rejected");

  expect(lost?.status === "rejected" && lost.reason).toMatchObject(
    refused(`Code ${code} is already approved.`),
  );

  const winner = left.status === "fulfilled" ? u : v;

  expect(deviceRows(box)).toMatchObject([{ status: "approved", userId: winner.id }]);

  await box.root.close({ graceful: true });
});

test("A8, A9: a wrong or expired code is a miss; ten misses lock approvals for 15 minutes", async () => {
  const box = await sandbox();

  const u = await signUp(box, "ursa");

  const old = await start(box);

  expire(box, old.code);

  await expect(approve(box, u, old.code)).rejects.toMatchObject(
    refused(/^No sign-in waits for code /),
  );

  for (let i = 1; i < 10; i++) {
    box.clock.advance(1000);

    await expect(approve(box, u, "ZZZZ-ZZZZ")).rejects.toMatchObject(
      refused('No sign-in waits for code "ZZZZ-ZZZZ"'),
    );
  }

  const { code } = await start(box);

  await expect(approve(box, u, code)).rejects.toMatchObject(
    refused(/^Too many wrong codes\. Wait 15 minutes/),
  );

  expect(deviceRows(box).find((row) => row.userCode === code.replace("-", ""))).toMatchObject({
    status: "pending",
    userId: null,
  });

  // 15 minutes after the first miss, it leaves the window: nine misses are under the cap.
  box.clock.advance(15 * 60_000 - 9000);

  expect((await approve(box, u, code)).text).toMatch(`Approved code ${code}`);

  await box.root.close({ graceful: true });
});

test("A10: finish before the approve answers 409 waiting and leaves the row and the cookie", async () => {
  const box = await sandbox();

  const { code, device } = await start(box);

  const response = await finish(box, device);

  expect(response.status).toBe(409);

  expect(await response.json()).toEqual({ state: "waiting" });

  expect(sessionCookie(response)).toBe("");

  expect(response.headers.getSetCookie().join()).not.toContain("tinker_device");

  expect(deviceRows(box)).toMatchObject([{ userCode: code.replace("-", ""), status: "pending" }]);

  expect(await stateOf(box, device)).toBe("waiting");

  await box.root.close({ graceful: true });
});

test("A11, A12, A14: finish signs in the approver once, marks the session, and keeps next safe", async () => {
  const box = await sandbox();

  const u = await signUp(box, "ursa");

  const { code, device } = await start(box, { next: "/board?tab=1" });

  await approve(box, u, code);

  const response = await finish(box, device);

  expect(response.status).toBe(200);

  expect(await response.json()).toEqual({ state: "signed_in", next: "/board?tab=1" });

  const cookie = sessionCookie(response);

  expect(cookie).not.toBe("");

  expect(
    response.headers.getSetCookie().find((value) => value.startsWith("tinker_device=")),
  ).toMatch(/^tinker_device=; Max-Age=0/);

  expect(deviceRows(box)).toEqual([]);

  expect(await whoIs(box, cookie)).toMatchObject({ id: u.id });

  const sessions = box.db.reader
    .prepare(
      `SELECT userId, signinCode, signinApprovedBy FROM "session" WHERE signinCode IS NOT NULL`,
    )
    .all();

  expect(sessions).toEqual([
    { userId: u.id, signinCode: code.replace("-", ""), signinApprovedBy: u.clientId },
  ]);

  const again = await finish(box, device);

  expect(again.status).toBe(410);

  expect(await again.json()).toEqual({ state: "gone" });

  expect(sessionCookie(again)).toBe("");

  expect(
    box.db.reader.prepare(`SELECT id FROM "session" WHERE signinCode IS NOT NULL`).all(),
  ).toHaveLength(1);

  for (const next of ["//evil", "https://x", "/\\x"]) {
    const other = await start(box, { next });

    await approve(box, u, other.code);

    expect(await (await finish(box, other.device)).json()).toEqual({
      state: "signed_in",
      next: "/",
    });
  }

  await box.root.close({ graceful: true });
});

test("A13: two finishes with one cookie at once make one session; the other answers 410", async () => {
  const box = await sandbox();

  const u = await signUp(box, "ursa");

  const { code, device } = await start(box);

  await approve(box, u, code);

  const replies = await Promise.all([finish(box, device), finish(box, device)]);

  expect(replies.map((reply) => reply.status).sort((a, b) => a - b)).toEqual([200, 410]);

  expect(replies.filter((reply) => sessionCookie(reply) !== "")).toHaveLength(1);

  expect(
    box.db.reader.prepare(`SELECT id FROM "session" WHERE signinCode IS NOT NULL`).all(),
  ).toHaveLength(1);

  await box.root.close({ graceful: true });
});

test("A16: the list shows live codes, the code only to its approver, and only the caller's sessions", async () => {
  const box = await sandbox();

  const u = await signUp(box, "ursa");

  const v = await signUp(box, "vale");

  const mine = await start(box);

  const theirs = await start(box);

  const open = await start(box);

  const used = await start(box);

  const gone = await start(box);

  await approve(box, u, mine.code);

  await approve(box, v, theirs.code);

  await approve(box, u, used.code);

  await finish(box, used.device);

  const vSignin = await start(box);

  await approve(box, v, vSignin.code);

  await finish(box, vSignin.device);

  expire(box, gone.code);

  const shown = await list(box, u);

  const waiting = shown.data.waiting;

  expect(waiting).toHaveLength(3);

  expect(waiting).toEqual(
    expect.arrayContaining([
      {
        at: expect.any(String),
        browser: "Chrome on Mac",
        kind: "web",
        approved: true,
        code: mine.code,
      },
      { at: expect.any(String), browser: "Chrome on Mac", kind: "web", approved: true },
      { at: expect.any(String), browser: "Chrome on Mac", kind: "web", approved: false },
    ]),
  );

  expect(JSON.stringify(shown)).not.toContain(theirs.code);

  expect(JSON.stringify(shown)).not.toContain(open.code);

  const [own] = box.db.reader
    .prepare(`SELECT id FROM "session" WHERE userId = ? AND signinCode IS NOT NULL`)
    .all(u.id) as { id: string }[];

  expect(shown.data.active).toEqual([
    {
      id: own.id,
      at: expect.any(String),
      browser: "Chrome on Mac",
      code: used.code,
      approvedBy: u.clientId,
    },
  ]);

  expect(shown.text).toMatch(/^Waiting codes: .+\.\nSigned in with a code: .+\.$/);

  expect(shown.text).toContain(`${own.id}: Chrome on Mac, since `);

  expect(shown.text).toContain(`(code ${used.code})`);

  await box.root.close({ graceful: true });
});

test("A17, A18: end signs out the caller's code session through Better Auth; others are refused", async () => {
  const box = await sandbox();

  const u = await signUp(box, "ursa");

  const v = await signUp(box, "vale");

  const { code, device } = await start(box);

  await approve(box, u, code);

  const cookie = sessionCookie(await finish(box, device));

  const other = await start(box);

  await approve(box, v, other.code);

  await finish(box, other.device);

  const ids = (who: Person) =>
    (
      box.db.reader
        .prepare(`SELECT id FROM "session" WHERE userId = ? AND signinCode IS NOT NULL`)
        .all(who.id) as { id: string }[]
    ).map((row) => row.id);

  const [uSession] = ids(u);

  const [vSession] = ids(v);

  const [password] = (
    box.db.reader
      .prepare(`SELECT id FROM "session" WHERE userId = ? AND signinCode IS NULL`)
      .all(u.id) as { id: string }[]
  ).map((row) => row.id);

  const count = () => box.db.reader.prepare(`SELECT id FROM "session"`).all().length;

  const before = count();

  await expect(end(box, u, vSession)).rejects.toMatchObject(refused(/^No code sign-in /));

  await expect(end(box, u, password)).rejects.toMatchObject(refused(/^No code sign-in /));

  expect(count()).toBe(before);

  const heard: string[] = [];

  const stop = await box.db.listen(
    "start_sync",
    (payload) => heard.push(payload),
    () => {},
  );

  expect((await end(box, u, uSession)).text).toBe(
    `Ended sign-in ${uSession}: that browser must sign in again.`,
  );

  expect(count()).toBe(before - 1);

  expect(await whoIs(box, cookie)).toBeNull();

  const deadline = Date.now() + 4000;

  while (!heard.includes(`account:${u.id}`) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  expect(heard).toEqual(["session", `account:${u.id}`]);

  stop();

  await expect(end(box, u, uSession)).rejects.toMatchObject(refused(/^No code sign-in /));

  await box.root.close({ graceful: true });
});

test("A19: the stock device routes are off over the auth mount", async () => {
  const box = await sandbox();

  await signUp(box, "ursa");

  for (const [path, body] of [
    ["device/code", { client_id: "web" }],
    [
      "device/token",
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: "x",
        client_id: "web",
      },
    ],
    ["device?user_code=BCDFGHJK", undefined],
    ["device/approve", { userCode: "BCDFGHJK" }],
    ["device/deny", { userCode: "BCDFGHJK" }],
  ] as const) {
    expect((await send(box, path, { body })).status, path).toBe(404);
  }

  await box.root.close({ graceful: true });
});

test("the approver tools need the caller tag", async () => {
  const box = await sandbox();

  // Core reads the tag before the run starts, so the call throws instead of rejecting.
  await expect(async () => box.root.run(listSignins, { input: {} })).rejects.toMatchObject({
    kind: "MissingTag",
    payload: { label: "auth.mcpCaller" },
  });

  await box.root.close({ graceful: true });
});
