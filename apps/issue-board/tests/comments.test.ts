import { createScope, isError as isCoreError, type Scope } from "@tinker/core";
import { beforeEach, afterEach, test, expect } from "vite-plus/test";

import { authStartup, authSettings } from "~/components/auth/index.server";
import { database, drizzleOrm, migrate, databaseUrl } from "~/components/database/index.server";
import { backendStop, startRequests } from "~/components/requests";
import { bootstrapSlot, readAccountSlot, event } from "~/components/sync/index.server";

import { comment as commentTable } from "@/backend/board.schema.server";
import { addComment } from "@/backend/comments.server";
import { changeIssue } from "@/backend/issues.server";
import { changeTeam, listTeams } from "@/backend/teams.server";
import { readAccount } from "@/demo/backend/auth.server";
import { bootstrap, replayPrivate } from "@/demo/backend/sync.server";
import { isError } from "@/demo/errors";

import { authBindings, handleAuth, proofDatabase, proofMail, requestHeaders } from "./presets";
import { write, settleWrite } from "./write-boundary";

let root: Scope.RootHandle;
let stop: AbortController;
let ada: Headers;
let grace: Headers;
let outsider: Headers;
let teamId: string;
let graceId: string;
let outsiderId: string;

const draft = {
  title: "First issue",
  description: "Details",
  state: "backlog",
  priority: 0,
  assigneeId: null,
};

beforeEach(async () => {
  stop = new AbortController();
  root = createScope({
    signal: stop.signal,
    extensions: [startRequests, authStartup],
    presets: [proofDatabase, proofMail],
    tags: [
      backendStop(stop.signal),
      authBindings,
      bootstrapSlot(bootstrap),
      readAccountSlot(readAccount),
      databaseUrl(new URL("postgres://proof")),
      authSettings({
        origin: "http://localhost:4318",
        secret: "test-secret-with-at-least-thirty-two-letters",
      }),
    ],
  });
  await root.ready;
  await root.run(migrate);

  const headers: Headers[] = [];
  for (const name of ["ada", "grace", "outsider"]) {
    const response = await root.run(handleAuth, {
      input: new Request("http://localhost:4318/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:4318" },
        body: JSON.stringify({ name, email: `${name}@example.com`, password: "safe-password-42" }),
      }),
      tags: requestHeaders(new Headers()),
    });
    expect(response.status).toBe(200);
    headers.push(
      new Headers({
        cookie: response.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; "),
      }),
    );
  }
  [ada, grace, outsider] = headers as [Headers, Headers, Headers];
  graceId = (await root.run(readAccount, { tags: requestHeaders(grace) }))!;
  outsiderId = (await root.run(readAccount, { tags: requestHeaders(outsider) }))!;

  await write(root, changeTeam, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: { kind: "create", key: "ENG", name: "Engineering" },
    },
    tags: requestHeaders(ada),
  });
  teamId = (await root.run(listTeams, { tags: requestHeaders(ada) }))[0]!.id;
  await write(root, changeTeam, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: { kind: "addMember", teamId, email: "grace@example.com" },
    },
    tags: requestHeaders(ada),
  });
});

afterEach(async () => {
  stop.abort();
  expect((await root.closed).status).toBe("success");
});

const post = { body: "  Ready for review.  " };

test("one comment fans out to members only, and retrying an execution adds nothing", async () => {
  await write(root, changeIssue, {
    rawInput: { executionId: crypto.randomUUID(), change: { ...draft, kind: "create", teamId } },
    tags: requestHeaders(ada),
  });
  const [issue] = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!;
  const command = {
    executionId: crypto.randomUUID(),
    comment: { ...post, teamId, issueId: issue!.id },
  };
  await write(root, addComment, { rawInput: command, tags: requestHeaders(ada) });
  await write(root, addComment, { rawInput: command, tags: requestHeaders(ada) });
  const snapshot = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!;
  const rows = snapshot.comments!;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    issueId: issue!.id,
    authorId: snapshot.profile.id,
    body: "Ready for review.",
  });
  expect(new Date(rows[0]!.createdAt).toISOString()).toBe(rows[0]!.createdAt);
  expect((await root.run(bootstrap, { tags: requestHeaders(grace) })).private!.comments).toEqual(
    rows,
  );

  const db = await root.resolve(database);
  const { eq } = await root.resolve(drizzleOrm);
  const events = await db.select().from(event).where(eq(event.executionId, command.executionId));
  expect(events).toHaveLength(3);
  expect(events.filter((row) => row.payload.kind === "result").map((row) => row.stream)).toEqual([
    snapshot.profile.id,
  ]);
  const changes = events.filter((row) => row.payload.kind === "change");
  expect(changes.map((row) => row.stream).sort()).toEqual([snapshot.profile.id, graceId].sort());
  expect(changes[0]!.payload).toEqual({
    kind: "change",
    change: { kind: "comment.add", comment: rows[0] },
  });
  expect(changes[1]!.payload).toEqual(changes[0]!.payload);
  expect(events.filter((row) => row.stream === outsiderId)).toEqual([]);
});

test("a non-member cannot read or add comments, and an issue cannot be addressed through another team", async () => {
  await write(root, changeIssue, {
    rawInput: { executionId: crypto.randomUUID(), change: { ...draft, kind: "create", teamId } },
    tags: requestHeaders(ada),
  });
  const [issue] = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!;
  await write(root, addComment, {
    rawInput: {
      executionId: crypto.randomUUID(),
      comment: { ...post, teamId, issueId: issue!.id },
    },
    tags: requestHeaders(ada),
  });
  for (const issueId of [issue!.id, crypto.randomUUID()]) {
    const refused = await settleWrite(root, addComment, {
      rawInput: { executionId: crypto.randomUUID(), comment: { ...post, teamId, issueId } },
      tags: requestHeaders(outsider),
    });
    expect(refused.status).toBe("failed");
    if (refused.status !== "failed") throw new Error("Expected member refusal");
    expect(isError(refused.error, "NotTeamMember")).toBe(true);
  }
  expect((await root.run(bootstrap, { tags: requestHeaders(outsider) })).private!.comments).toEqual(
    [],
  );
  const outsiderEvents = await root.run(replayPrivate, {
    rawInput: { accountId: outsiderId, after: 0 },
    tags: requestHeaders(outsider),
  });
  expect(outsiderEvents).toEqual([]);

  await write(root, changeTeam, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: { kind: "create", key: "OPS", name: "Operations" },
    },
    tags: requestHeaders(ada),
  });
  const other = (await root.run(listTeams, { tags: requestHeaders(ada) })).find(
    (row) => row.key === "OPS",
  )!;
  await write(root, changeIssue, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: { ...draft, kind: "create", teamId: other.id },
    },
    tags: requestHeaders(ada),
  });
  const foreign = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!.find(
    (row) => row.teamId === other.id,
  )!;
  const refused = await settleWrite(root, addComment, {
    rawInput: {
      executionId: crypto.randomUUID(),
      comment: { ...post, teamId, issueId: foreign.id },
    },
    tags: requestHeaders(grace),
  });
  expect(refused.status).toBe("failed");
  if (refused.status !== "failed") throw new Error("Expected scoped issue refusal");
  expect(isError(refused.error, "IssueMissing")).toBe(true);
});

test("comment input bounds the body and refuses author, metadata, and operation keys", async () => {
  for (const extra of [
    { body: " " },
    { body: "x".repeat(5001) },
    { authorId: outsiderId },
    { id: crypto.randomUUID() },
    { kind: "edit" },
    { kind: "remove" },
    { createdAt: "1990-01-01T00:00:00.000Z" },
  ]) {
    const result = await settleWrite(root, addComment, {
      rawInput: {
        executionId: crypto.randomUUID(),
        comment: { ...post, teamId, issueId: crypto.randomUUID(), ...extra },
      },
      tags: requestHeaders(ada),
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected invalid comment refusal");
    expect(isCoreError(result.error, "DataValidationFailed")).toBe(true);
  }
  expect(await (await root.resolve(database)).select().from(commentTable)).toEqual([]);
});

test("a newly added member receives existing issues and comments without a reload", async () => {
  await write(root, changeIssue, {
    rawInput: { executionId: crypto.randomUUID(), change: { ...draft, kind: "create", teamId } },
    tags: requestHeaders(ada),
  });
  const [issue] = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!;
  await write(root, addComment, {
    rawInput: {
      executionId: crypto.randomUUID(),
      comment: { ...post, teamId, issueId: issue!.id },
    },
    tags: requestHeaders(grace),
  });

  const old = (await root.run(bootstrap, { tags: requestHeaders(outsider) })).private!;
  expect(old.comments).toEqual([]);
  const executionId = crypto.randomUUID();
  await write(root, changeTeam, {
    rawInput: { executionId, change: { kind: "addMember", teamId, email: "outsider@example.com" } },
    tags: requestHeaders(ada),
  });

  const events = await root.run(replayPrivate, {
    rawInput: { accountId: outsiderId, after: old.revision },
    tags: requestHeaders(outsider),
  });
  const rows = (await root.run(bootstrap, { tags: requestHeaders(grace) })).private!.comments!;
  expect(
    events.map((row) => (row.payload.kind === "change" ? row.payload.change.kind : "result")),
  ).toEqual(["teams", "issue.upsert", "comment.add"]);
  expect(events[2]!.payload).toEqual({
    kind: "change",
    change: { kind: "comment.add", comment: rows[0] },
  });
});

test("issue removal cascades its comments", async () => {
  await write(root, changeIssue, {
    rawInput: { executionId: crypto.randomUUID(), change: { ...draft, kind: "create", teamId } },
    tags: requestHeaders(ada),
  });
  const [issue] = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!;
  await write(root, addComment, {
    rawInput: {
      executionId: crypto.randomUUID(),
      comment: { ...post, teamId, issueId: issue!.id },
    },
    tags: requestHeaders(ada),
  });

  await write(root, changeIssue, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: { kind: "remove", id: issue!.id, teamId, version: issue!.version },
    },
    tags: requestHeaders(grace),
  });

  const db = await root.resolve(database);
  expect(await db.select().from(commentTable)).toEqual([]);
  expect((await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.comments).toEqual([]);
});

test("a failed event insert rolls back the entire comment", async () => {
  const db = await root.resolve(database);
  await write(root, changeIssue, {
    rawInput: { executionId: crypto.randomUUID(), change: { ...draft, kind: "create", teamId } },
    tags: requestHeaders(ada),
  });
  const [next] = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!;
  const before = (await root.run(bootstrap, { tags: requestHeaders(grace) })).private!;
  const { sql } = await root.resolve(drizzleOrm);
  await db.execute(
    sql`CREATE FUNCTION reject_comment_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->'change'->>'kind' = 'comment.add' THEN RAISE EXCEPTION 'proof comment event refused'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER reject_comment_event BEFORE INSERT ON sync_event FOR EACH ROW EXECUTE FUNCTION reject_comment_event()`,
  );

  const result = await settleWrite(root, addComment, {
    rawInput: { executionId: crypto.randomUUID(), comment: { ...post, teamId, issueId: next!.id } },
    tags: requestHeaders(ada),
  });
  expect(result.status).toBe("failed");
  expect(await db.select().from(commentTable)).toEqual([]);
  expect((await root.run(bootstrap, { tags: requestHeaders(grace) })).private).toEqual(before);
});

test("database checks comment text when the input reader is bypassed", async () => {
  await write(root, changeIssue, {
    rawInput: { executionId: crypto.randomUUID(), change: { ...draft, kind: "create", teamId } },
    tags: requestHeaders(ada),
  });
  const snapshot = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!;
  const db = await root.resolve(database);
  const values = { issueId: snapshot.issues![0]!.id, authorId: snapshot.profile.id };

  for (const body of [
    "",
    " ",
    "\t\n\r",
    "\u00a0\ufeff\u2000",
    "x".repeat(5001),
    " \t" + "x".repeat(5000) + "\ufeff",
  ]) {
    await expect(
      db.insert(commentTable).values({ ...values, id: crypto.randomUUID(), body }),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint: "comment_body" } });
  }
  expect(await db.select().from(commentTable)).toEqual([]);

  for (const body of ["x", "x".repeat(5000)]) {
    await db.insert(commentTable).values({ ...values, id: crypto.randomUUID(), body });
  }
  expect(await db.select().from(commentTable)).toHaveLength(2);
});
