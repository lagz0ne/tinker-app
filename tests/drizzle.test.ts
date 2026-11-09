import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bunSql } from "@tinker/bun/sql";
import { bunSqlite } from "@tinker/bun/sqlite";
import { capsule, createScope } from "@tinker/core";
import type { Scope } from "@tinker/core";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { drizzlePg } from "~/components/drizzle-pg/index.server";
import { drizzleSqlite } from "~/components/drizzle-sqlite/index.server";
import { pglite } from "~/components/pglite/index.server";

import * as pgOps from "./drizzle/notes-pg";
import * as sqliteOps from "./drizzle/notes-sqlite";

const folder = mkdtempSync(join(tmpdir(), "drizzle-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

/** A Postgres server for Bun.sql: CI sets it; without it that driver is skipped. */
const PG_URL = process.env.PG_URL;
const pgMigrations = "tests/drizzle/migrations/pg";
const sqliteMigrations = "tests/drizzle/migrations/sqlite";

/** A call that owns its session (ADR 0090): its end commits or rolls back its tx. */
const own = () => ({ signal: new AbortController().signal });

/** One row per driver. The app's operations and the checks never change. */
const drivers = [
  {
    name: "Postgres / Bun.sql",
    skip: !PG_URL,
    ops: pgOps,
    capsules: () => [
      bunSql({ url: new URL(PG_URL ?? "postgres://unset") }),
      drizzlePg({ driver: bunSql.connection, migrations: pgMigrations }),
    ],
  },
  {
    name: "SQLite / bun:sqlite",
    skip: false,
    ops: sqliteOps,
    capsules: () => [
      bunSqlite({ file: join(folder, "bun.db") }),
      drizzleSqlite({ driver: bunSqlite.connection, migrations: sqliteMigrations }),
    ],
  },
  {
    name: "Postgres / PGlite",
    skip: false,
    ops: pgOps,
    capsules: () => [pglite(), drizzlePg({ driver: pglite.connection, migrations: pgMigrations })],
  },
];

for (const driver of drivers) {
  describe.skipIf(driver.skip)(driver.name, () => {
    // Both op sets share one shape; the pg type stands for both.
    const ops = driver.ops as typeof pgOps;
    let app: Scope.Handle;

    beforeAll(async () => {
      app = await createScope({ capsules: driver.capsules() as never }).ready;
      await app.ready;
    }, 30_000);
    afterAll(async () => void (await app.close()));

    test("start migrates; a typed insert and select follow", async () => {
      if (driver.name.includes("Bun.sql")) await app.run(ops.clearNotes, own());
      const row = await app.run(ops.addNote, { input: { title: "first" }, ...own() });
      expect(row).toMatchObject({ title: "first", votes: 0 });
      expect((await app.run(ops.listNotes)).map((note) => note.title)).toEqual(["first"]);
    });

    test("a failed call rolls back every write of its session", async () => {
      expect((await app.settle(ops.addTwoThenFail, own())).status).toBe("failed");
      expect((await app.run(ops.listNotes)).map((note) => note.title)).toEqual(["first"]);
    });

    test("a subflow shares the parent's transaction", async () => {
      const session = app.createSession();
      await session.run(ops.addAndVote, { input: { title: "second" } });
      expect((await session.close({ graceful: true })).status).toBe("success");
      const notes = await app.run(ops.listNotes);
      expect(notes.map((note) => [note.title, note.votes])).toEqual([
        ["first", 0],
        ["second", 1],
      ]);
    });

    test("ten parallel calls each commit their own transaction", async () => {
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          app.run(ops.addNote, { input: { title: `parallel ${index}` }, ...own() }),
        ),
      );
      expect(await app.run(ops.listNotes)).toHaveLength(12);
    });

    test("own: a subflow with signal commits on its own; the joined rest rolls back", async () => {
      expect((await app.settle(ops.keepOneThenFail, own())).status).toBe("failed");
      const titles = (await app.run(ops.listNotes)).map((note) => note.title);
      expect(titles.filter((title) => title === "kept")).toHaveLength(1);
      expect(titles).not.toContain("ghost 1");
    });

    test("boundary: a root run with no session of its own is refused", async () => {
      const result = await app.settle(ops.addNote, { input: { title: "nowhere" } });
      expect(result.status === "failed" && Object(result.error).kind).toBe(
        "TransactionNeedsSession",
      );
    });

    test("a later capsule's start sees the migrated schema", async () => {
      let seen: unknown;
      const later = capsule({
        label: "later",
        hooks: {
          async start({ next, run }) {
            seen = await run(ops.listNotes, {}, { role: "setup", explain: "Reads at start" });
            await next();
          },
        },
      });

      await using scope = await createScope({ capsules: [...driver.capsules(), later] as never })
        .ready;

      expect(Array.isArray(seen)).toBe(true);
    });

    test("the capsule record shows the driver and migrate as setup", () => {
      const record = app.capsules.find((entry) => entry.label.startsWith("drizzle"))!;
      expect(record.exports).toEqual(["db", "tx", "migrate"]);
      expect(record.loaded.map((loaded) => loaded.role)).toContain("setup");
    });
  });
}

test("no driver is a type error and fails at createScope", () => {
  // @ts-expect-error driver is required
  expect(() => createScope({ capsules: [drizzlePg()] })).toThrow("MissingConfig");
});

test("a forced session close rolls back; a graceful close commits", async () => {
  const app = await createScope({
    capsules: [pglite(), drizzlePg({ driver: pglite.connection, migrations: pgMigrations })],
  }).ready;

  const forced = app.createSession();
  await forced.run(pgOps.addNote, { input: { title: "dropped" } });
  expect((await forced.close()).status).toBe("cancelled");

  const graceful = app.createSession();
  await graceful.run(pgOps.addNote, { input: { title: "kept" } });
  expect((await graceful.close({ graceful: true })).status).toBe("success");

  expect((await app.run(pgOps.listNotes)).map((note) => note.title)).toEqual(["kept"]);
  await app.close();
}, 30_000);
