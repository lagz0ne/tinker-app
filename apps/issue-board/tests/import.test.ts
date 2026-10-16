import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createScope, type Scope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { beforeEach, afterEach, expect, test } from "vite-plus/test";

import { user } from "~/components/auth/index.server";
import { database, migrate } from "~/components/database/index.server";
import { event, execution } from "~/components/sync/index.server";

import { team, teamMember, issue, mailOutbox } from "@/backend/board.schema.server";
import {
  readImport,
  importBatch,
  runImport,
  importTeam,
  importActor,
  importFile,
} from "@/backend/import.server";
import { files } from "@/backend/modules";

import { proofDatabase, databaseQueries } from "./presets";

let root: Scope.RootHandle;
let stop: AbortController;

const row = {
  externalId: "OLD-1",
  title: "Imported",
  description: "",
  state: "todo",
  priority: 2,
  assignee: "grace@example.test",
};

beforeEach(async () => {
  stop = new AbortController();
  root = createScope({
    signal: stop.signal,
    presets: [proofDatabase],
    tags: [importTeam("ENG"), importActor("ada@example.test")],
  });
  await root.ready;

  await root.run(migrate);

  const db = await root.resolve(database);

  const teamId = crypto.randomUUID();
  await db
    .insert(user)
    .values(
      ["ada", "grace", "outsider"].map((id) => ({ id, name: id, email: `${id}@example.test` })),
    );
  await db.insert(team).values({ id: teamId, key: "ENG", name: "Engineering" });
  await db.insert(teamMember).values([
    { teamId, userId: "ada", role: "admin" },
    { teamId, userId: "grace", role: "member" },
  ]);
});

afterEach(async () => {
  stop.abort();
  expect((await root.closed).status).toBe("success");
});

test("CSV reads Linear headers, BOM, commas, escaped quotes and multiline cells", async () => {
  expect(
    await root.run(readImport, {
      rawInput:
        '\uFEFFID,Title,Description,Status,Priority,Assignee\r\nOLD-1,"Hello, ""world""","one\r\ntwo",In Progress,High,grace@example.test\r\n',
    }),
  ).toEqual([{ ...row, title: 'Hello, "world"', description: "one\r\ntwo", state: "in_progress" }]);
  expect(await root.run(readImport, { rawInput: "ID,Title\nx,Simple" })).toEqual([
    { ...row, externalId: "x", title: "Simple", state: "backlog", priority: 0, assignee: "" },
  ]);
});

test("CSV refuses bad quotes, missing and repeated IDs, bad states and priorities", async () => {
  for (const csv of [
    'ID,Title\nx,"unclosed',
    'ID,Title\nx,bad"quote',
    'ID,Title\nx,"closed"x',
    "Title\nx",
    "ID,ID,Title\nx,x,title",
    "ID,Title\nx,title,extra",
    "ID,Title\n,title",
    "ID,Title\nx,one\nx,two",
    "ID,Title,Status\nx,title,Unknown",
    "ID,Title,Priority\nx,title,5",
  ]) {
    await expect(root.run(readImport, { rawInput: csv })).rejects.toThrow();
  }
});

test("upsert sends member events and peer mail; replay has no saved effects", async () => {
  const db = await root.resolve(database);

  expect(await root.run(importBatch, { rawInput: { rows: [row] } })).toEqual({ changed: 1 });
  const [saved] = await db.select().from(issue);
  expect(saved).toMatchObject({
    externalId: "OLD-1",
    number: 1,
    version: 1,
    assigneeId: "grace",
    creatorId: "ada",
  });
  expect((await db.select().from(event)).map((entry) => entry.stream).sort()).toEqual([
    "ada",
    "ada",
    "grace",
  ]);
  expect((await db.select().from(mailOutbox)).map((entry) => entry.to)).toEqual([
    "grace@example.test",
  ]);
  expect(await root.run(importBatch, { rawInput: { rows: [row] } })).toEqual({ changed: 0 });
  expect(await db.select().from(event)).toHaveLength(3);
  expect(await db.select().from(mailOutbox)).toHaveLength(1);
  expect(await db.select().from(execution)).toHaveLength(1);
  expect((await db.select().from(team))[0]!.issueSeq).toBe(1);
  await root.run(importBatch, { rawInput: { rows: [{ ...row, title: "Changed" }] } });
  expect((await db.select().from(issue))[0]).toMatchObject({
    id: saved!.id,
    number: 1,
    version: 2,
    rank: saved!.rank,
  });
  await root.run(importBatch, {
    rawInput: { rows: [{ ...row, title: "Changed", state: "done", assignee: "" }] },
  });
  expect((await db.select().from(issue))[0]).toMatchObject({
    state: "done",
    assigneeId: null,
    version: 3,
  });
});

test("refused actor and bad assignee leave the whole batch unchanged", async () => {
  const db = await root.resolve(database);

  await expect(
    root.run(importBatch, {
      rawInput: { rows: [row] },
      tags: importActor("outsider@example.test"),
    }),
  ).rejects.toThrow();
  await expect(
    root.run(importBatch, {
      rawInput: { rows: [row, { ...row, externalId: "OLD-2", assignee: "outsider@example.test" }] },
    }),
  ).rejects.toThrow();
  expect(await db.select().from(issue)).toHaveLength(0);
  expect(await db.select().from(event)).toHaveLength(0);
  expect(await db.select().from(mailOutbox)).toHaveLength(0);
  expect((await db.select().from(team))[0]!.issueSeq).toBe(0);
});

test("external ID is scoped to its team", async () => {
  const db = await root.resolve(database);

  await root.run(importBatch, { rawInput: { rows: [row] } });
  const ops = crypto.randomUUID();
  await db.insert(team).values({ id: ops, key: "OPS", name: "Operations" });
  await db.insert(teamMember).values({ teamId: ops, userId: "ada", role: "admin" });
  await root.run(importBatch, {
    rawInput: { rows: [{ ...row, assignee: "" }] },
    tags: importTeam("OPS"),
  });
  expect(await db.select().from(issue)).toHaveLength(2);
});

test("file import uses batches of 100 and checks the whole CSV before any write", async () => {
  let csv =
    "ID,Title\r\n" +
    Array.from({ length: 201 }, (_, index) => `OLD-${index},Title ${index}`).join("\r\n");
  const sizes: number[] = [];
  const fileRoot = createScope({
    signal: stop.signal,
    presets: [
      preset(files, async () => ({ readFile: async () => csv }) as never),
      preset(importBatch, async (_deps, { input }) => {
        sizes.push(input.rows.length);
        return { changed: input.rows.length };
      }),
    ],
    tags: [importFile("issues.csv")],
  });
  await fileRoot.ready;

  try {
    expect(await fileRoot.run(runImport)).toEqual({ rows: 201, changed: 201 });
    expect(sizes).toEqual([100, 100, 1]);

    sizes.length = 0;
    csv += '\r\nbad,"unclosed';
    await expect(fileRoot.run(runImport)).rejects.toThrow();
    expect(sizes).toEqual([]);
  } finally {
    await fileRoot.close();
  }
  databaseQueries.length = 0;
  await expect(
    Promise.resolve().then(() =>
      root.run(importBatch, { rawInput: { rows: Array.from({ length: 101 }, () => row) } }),
    ),
  ).rejects.toThrow();
  expect(databaseQueries).toEqual([]);
});

test("a failed second group keeps the first hundred rows, and a fixed rerun finishes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "board-import-"));
  const path = join(directory, "issues.csv");
  const lines = Array.from({ length: 101 }, (_, index) => `OLD-${index},Row ${index},`);
  const db = await root.resolve(database);

  try {
    lines[100] = "OLD-100,Row 100,outsider@example.test";
    await writeFile(path, "ID,Title,Assignee\r\n" + lines.join("\r\n"));
    await expect(root.run(runImport, { tags: importFile(path) })).rejects.toThrow();
    expect(await db.select().from(issue)).toHaveLength(100);
    expect((await db.select().from(team))[0]!.issueSeq).toBe(100);
    expect(await db.select().from(event)).toHaveLength(300);
    expect(await db.select().from(mailOutbox)).toHaveLength(100);

    lines[100] = "OLD-100,Row 100,";
    await writeFile(path, "ID,Title,Assignee\r\n" + lines.join("\r\n"));
    expect(await root.run(runImport, { tags: importFile(path) })).toEqual({
      rows: 101,
      changed: 1,
    });
    expect(await db.select().from(issue)).toHaveLength(101);
    expect((await db.select().from(team))[0]!.issueSeq).toBe(101);
    expect(await db.select().from(event)).toHaveLength(303);
    expect(await db.select().from(mailOutbox)).toHaveLength(101);
  } finally {
    await rm(directory, { recursive: true });
  }
});
