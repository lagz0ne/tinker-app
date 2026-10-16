import { createScope, isError as isCoreError, type Scope } from "@tinker/core";
import { beforeEach, afterEach, test, expect } from "vite-plus/test";

import { authStartup, authSettings } from "~/components/auth/index.server";
import { database, drizzleOrm, migrate, databaseUrl } from "~/components/database/index.server";
import { backendStop, startRequests } from "~/components/requests";
import { bootstrapSlot, readAccountSlot, event } from "~/components/sync/index.server";

import { team, issue } from "@/backend/board.schema.server";
import { changeIssue, listTeamMembers } from "@/backend/issues.server";
import { changeTeam, listTeams } from "@/backend/teams.server";
import { readAccount } from "@/demo/backend/auth.server";
import { bootstrap } from "@/demo/backend/sync.server";
import { isError } from "@/demo/errors";

import {
  authBindings,
  handleAuth,
  proofDatabase,
  proofMail,
  requestHeaders,
  databaseQueries,
} from "./presets";

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

  await root.run(changeTeam, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: { kind: "create", key: "ENG", name: "Engineering" },
    },
    tags: requestHeaders(ada),
  });
  teamId = (await root.run(listTeams, { tags: requestHeaders(ada) }))[0]!.id;
  await root.run(changeTeam, {
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

test("sequential numbering gives ENG-1 through ENG-20 with one counter UPDATE per create", async () => {
  databaseQueries.length = 0;
  for (let index = 0; index < 20; index++) {
    await root.run(changeIssue, {
      rawInput: {
        executionId: crypto.randomUUID(),
        change: { ...draft, kind: "create", teamId, title: `Issue ${index}` },
      },
      tags: requestHeaders(index % 2 === 0 ? ada : grace),
    });
  }

  const rows = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!;
  expect(rows.map((row) => row.number)).toEqual(
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  expect(new Set(rows.map((row) => row.id)).size).toBe(20);
  expect(rows.every((row) => row.teamKey === "ENG")).toBe(true);
  expect((await (await root.resolve(database)).select().from(team))[0]!.issueSeq).toBe(20);
  expect(
    databaseQueries.filter(
      (query) => query.startsWith('update "team" set "issue_seq"') && query.includes("returning"),
    ),
  ).toHaveLength(20);
});

test("repeated execution IDs do not create a second row or increment the number; members can edit and assign", async () => {
  const create = { executionId: crypto.randomUUID(), change: { ...draft, kind: "create", teamId } };
  await Promise.all([
    root.run(changeIssue, { rawInput: create, tags: requestHeaders(ada) }),
    root.run(changeIssue, { rawInput: create, tags: requestHeaders(ada) }),
  ]);
  const [row] = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!;
  const edit = {
    executionId: crypto.randomUUID(),
    change: {
      ...draft,
      kind: "edit",
      teamId,
      id: row!.id,
      version: row!.version,
      title: "Assigned work",
      state: "in_progress",
      priority: 1,
      assigneeId: graceId,
    },
  };
  await root.run(changeIssue, { rawInput: edit, tags: requestHeaders(grace) });
  await root.run(changeIssue, { rawInput: edit, tags: requestHeaders(grace) });

  const rows = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!;
  expect(rows).toEqual([
    {
      ...row,
      title: "Assigned work",
      state: "in_progress",
      priority: 1,
      assigneeId: graceId,
      version: 2,
    },
  ]);
  expect((await (await root.resolve(database)).select().from(team))[0]!.issueSeq).toBe(1);
  expect((await root.run(bootstrap, { tags: requestHeaders(grace) })).private?.issues).toEqual(
    rows,
  );
  expect(
    await root.run(listTeamMembers, { rawInput: { teamId }, tags: requestHeaders(ada) }),
  ).toHaveLength(2);
});

test("a non-member cannot create, edit an existing or missing issue, or read issues and members", async () => {
  await root.run(changeIssue, {
    rawInput: { executionId: crypto.randomUUID(), change: { ...draft, kind: "create", teamId } },
    tags: requestHeaders(ada),
  });
  const rows = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!;

  for (const change of [
    { ...draft, kind: "create", teamId },
    { ...draft, kind: "edit", teamId, id: rows[0]!.id, version: rows[0]!.version },
    {
      kind: "move",
      teamId,
      id: rows[0]!.id,
      version: rows[0]!.version,
      state: "done",
      beforeId: null,
    },
    { kind: "remove", teamId, id: rows[0]!.id, version: rows[0]!.version },
    { ...draft, kind: "edit", teamId, id: crypto.randomUUID(), version: 1 },
  ]) {
    const result = await root.settle(changeIssue, {
      rawInput: { executionId: crypto.randomUUID(), change },
      tags: requestHeaders(outsider),
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected membership refusal");
    expect(isError(result.error, "NotTeamMember")).toBe(true);
  }
  expect((await root.run(bootstrap, { tags: requestHeaders(outsider) })).private?.issues).toEqual(
    [],
  );
  const reads = [
    await root.settle(listTeamMembers, { rawInput: { teamId }, tags: requestHeaders(outsider) }),
  ];
  for (const result of reads) {
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected membership refusal");
    expect(isError(result.error, "NotTeamMember")).toBe(true);
  }

  expect((await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!).toEqual(rows);
  expect((await (await root.resolve(database)).select().from(team))[0]!.issueSeq).toBe(1);
});

test("an insert failure rolls back the increment so the next issue is ENG-1", async () => {
  const { sql } = await root.resolve(drizzleOrm);
  const db = await root.resolve(database);
  await db.execute(
    sql`CREATE FUNCTION reject_issue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title = 'Refuse insert' THEN RAISE EXCEPTION 'proof insert refused'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER reject_issue BEFORE INSERT ON issue FOR EACH ROW EXECUTE FUNCTION reject_issue()`,
  );

  const refused = await root.settle(changeIssue, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: { ...draft, kind: "create", teamId, title: "Refuse insert" },
    },
    tags: requestHeaders(ada),
  });
  expect(refused.status).toBe("failed");
  expect((await db.select().from(team))[0]!.issueSeq).toBe(0);
  expect((await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!).toEqual([]);

  await root.run(changeIssue, {
    rawInput: { executionId: crypto.randomUUID(), change: { ...draft, kind: "create", teamId } },
    tags: requestHeaders(ada),
  });
  expect(
    (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!.map(
      (row) => row.number,
    ),
  ).toEqual([1]);
});

test("invalid assignees, states, priorities, and caller-selected creators save no issue", async () => {
  const assignee = await root.settle(changeIssue, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: { ...draft, kind: "create", teamId, assigneeId: outsiderId },
    },
    tags: requestHeaders(ada),
  });
  expect(assignee.status).toBe("failed");
  if (assignee.status !== "failed") throw new Error("Expected assignee refusal");
  expect(isError(assignee.error, "InvalidAssignee")).toBe(true);

  for (const extra of [
    { state: "unknown" },
    { priority: -1 },
    { priority: 5 },
    { creatorId: outsiderId },
    { title: " " },
  ]) {
    const result = await root.settle(changeIssue, {
      rawInput: {
        executionId: crypto.randomUUID(),
        change: { ...draft, ...extra, kind: "create", teamId },
      },
      tags: requestHeaders(ada),
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected input refusal");
    expect(isCoreError(result.error, "DataValidationFailed")).toBe(true);
  }

  expect((await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!).toEqual([]);
  expect((await (await root.resolve(database)).select().from(team))[0]!.issueSeq).toBe(0);
});

test("editing a missing issue is refused without changing the team counter", async () => {
  const result = await root.settle(changeIssue, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: { ...draft, kind: "edit", teamId, id: crypto.randomUUID(), version: 1 },
    },
    tags: requestHeaders(ada),
  });

  expect(result.status).toBe("failed");
  if (result.status !== "failed") throw new Error("Expected missing issue refusal");
  expect(isError(result.error, "IssueMissing")).toBe(true);
  expect((await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!).toEqual([]);
  expect((await (await root.resolve(database)).select().from(team))[0]!.issueSeq).toBe(0);
});

test("row changes fan out to both members, results only to the actor, and nothing to a non-member", async () => {
  const executionId = crypto.randomUUID();
  await root.run(changeIssue, {
    rawInput: { executionId, change: { ...draft, kind: "create", teamId } },
    tags: requestHeaders(ada),
  });
  const db = await root.resolve(database);
  const { eq } = await root.resolve(drizzleOrm);
  const events = await db.select().from(event).where(eq(event.executionId, executionId));
  const adaId = (await root.run(readAccount, { tags: requestHeaders(ada) }))!;
  expect(events.filter((row) => row.stream === outsiderId)).toEqual([]);
  expect(events.filter((row) => row.payload.kind === "result").map((row) => row.stream)).toEqual([
    adaId,
  ]);
  const changes = events.filter((row) => row.payload.kind === "change");
  expect(changes.map((row) => row.stream).sort()).toEqual([adaId, graceId].sort());
  expect(changes[0]!.payload).toEqual(changes[1]!.payload);
  expect(changes[0]!.payload).toMatchObject({
    kind: "change",
    change: { kind: "issue.upsert", issue: { number: 1, version: 1 } },
  });
  expect(JSON.stringify(changes)).not.toContain('"rows"');

  const [row] = (await root.run(bootstrap, { tags: requestHeaders(grace) })).private!.issues!;
  const removeId = crypto.randomUUID();
  await root.run(changeIssue, {
    rawInput: {
      executionId: removeId,
      change: { kind: "remove", id: row!.id, version: row!.version, teamId },
    },
    tags: requestHeaders(grace),
  });
  const removed = await db.select().from(event).where(eq(event.executionId, removeId));
  expect(removed.filter((row) => row.payload.kind === "change").map((row) => row.payload)).toEqual([
    { kind: "change", change: { kind: "issue.remove", id: row!.id } },
    { kind: "change", change: { kind: "issue.remove", id: row!.id } },
  ]);
  expect((await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues).toEqual([]);
});

test("a move between two fractional keys sorts between them; stale saves cannot undo it", async () => {
  for (let index = 0; index < 3; index++) {
    await root.run(changeIssue, {
      rawInput: {
        executionId: crypto.randomUUID(),
        change: { ...draft, kind: "create", teamId, title: `Card ${index}` },
      },
      tags: requestHeaders(ada),
    });
  }
  const [first, second, third] = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!
    .issues!;
  await root.run(changeIssue, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: {
        kind: "move",
        teamId,
        id: third!.id,
        version: third!.version,
        state: "backlog",
        beforeId: second!.id,
      },
    },
    tags: requestHeaders(grace),
  });
  const rows = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!;
  expect(rows.map((row) => row.id)).toEqual([first!.id, third!.id, second!.id]);
  expect(rows[1]!.rank > first!.rank && rows[1]!.rank < second!.rank).toBe(true);
  expect(rows[1]!.version).toBe(2);

  databaseQueries.length = 0;
  for (const change of [
    { ...draft, kind: "edit", teamId, id: third!.id, version: third!.version },
    { kind: "move", teamId, id: third!.id, version: third!.version, state: "done", beforeId: null },
    { kind: "remove", teamId, id: third!.id, version: third!.version },
  ]) {
    const refused = await root.settle(changeIssue, {
      rawInput: { executionId: crypto.randomUUID(), change },
      tags: requestHeaders(ada),
    });
    expect(refused.status).toBe("failed");
    if (refused.status !== "failed") throw new Error("Expected stale version refusal");
    expect(isError(refused.error, "IssueConflict")).toBe(true);
  }
  const guardedWrites = databaseQueries.filter((query) =>
    /^(update|delete from) "issue"/.test(query),
  );
  expect(guardedWrites).toHaveLength(3);
  expect(guardedWrites.every((query) => /where.*"issue"\."version" = \$\d+/.test(query))).toBe(
    true,
  );
  expect((await root.run(bootstrap, { tags: requestHeaders(grace) })).private!.issues).toEqual(
    rows,
  );
});

test("an edit into another column gets a fresh end rank and a later drop can go between the cards", async () => {
  for (const [title, state] of [
    ["A", "backlog"],
    ["B", "todo"],
    ["C", "backlog"],
  ]) {
    await root.run(changeIssue, {
      rawInput: {
        executionId: crypto.randomUUID(),
        change: { ...draft, kind: "create", teamId, title, state },
      },
      tags: requestHeaders(ada),
    });
  }
  const original = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!;
  const a = original.find((row) => row.title === "A")!;
  const b = original.find((row) => row.title === "B")!;
  const c = original.find((row) => row.title === "C")!;
  expect(a.rank).toBe(b.rank);

  await root.run(changeIssue, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: {
        ...draft,
        kind: "edit",
        teamId,
        id: b.id,
        version: b.version,
        title: "B",
        state: "backlog",
      },
    },
    tags: requestHeaders(ada),
  });
  const edited = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!;
  expect(new Set(edited.map((row) => row.rank)).size).toBe(3);
  expect(edited.find((row) => row.id === b.id)!.rank > c.rank).toBe(true);
  await root.run(changeIssue, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: {
        kind: "move",
        teamId,
        id: c.id,
        version: c.version,
        state: "backlog",
        beforeId: b.id,
      },
    },
    tags: requestHeaders(grace),
  });
  const moved = (await root.run(bootstrap, { tags: requestHeaders(grace) })).private!.issues!;
  expect(moved.map((row) => row.id)).toEqual([a.id, c.id, b.id]);
  expect(a.rank < moved[1]!.rank && moved[1]!.rank < moved[2]!.rank).toBe(true);

  databaseQueries.length = 0;
  await root.run(changeIssue, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: {
        ...draft,
        kind: "edit",
        teamId,
        id: b.id,
        version: 2,
        title: "B renamed",
        state: "backlog",
      },
    },
    tags: requestHeaders(ada),
  });
  expect(
    (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!.find(
      (row) => row.id === b.id,
    )!.rank,
  ).toBe(moved[2]!.rank);
  expect(
    databaseQueries.filter((query) => query.startsWith('select "id", "rank" from "issue"')),
  ).toEqual([]);
});

test("a legacy equal-rank gap returns InvalidPosition rather than a plain library error", async () => {
  for (let index = 0; index < 3; index++) {
    await root.run(changeIssue, {
      rawInput: { executionId: crypto.randomUUID(), change: { ...draft, kind: "create", teamId } },
      tags: requestHeaders(ada),
    });
  }

  const rows = (await root.run(bootstrap, { tags: requestHeaders(ada) })).private!.issues!;
  const { eq } = await root.resolve(drizzleOrm);
  const db = await root.resolve(database);
  await db.update(issue).set({ rank: rows[0]!.rank }).where(eq(issue.id, rows[1]!.id));

  const duplicate = (
    await root.run(bootstrap, { tags: requestHeaders(ada) })
  ).private!.issues!.filter((row) => row.rank === rows[0]!.rank);
  const result = await root.settle(changeIssue, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: {
        kind: "move",
        teamId,
        id: rows[2]!.id,
        version: 1,
        state: "backlog",
        beforeId: duplicate[1]!.id,
      },
    },
    tags: requestHeaders(ada),
  });
  expect(result.status).toBe("failed");
  if (result.status !== "failed") throw new Error("Expected invalid gap refusal");
  expect(isError(result.error, "InvalidPosition")).toBe(true);
});
