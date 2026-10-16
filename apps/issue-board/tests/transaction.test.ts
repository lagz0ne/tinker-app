import { createScope, operation, resource } from "@tinker/core";
import { expect, test } from "vite-plus/test";
import { z } from "zod";

import { database, drizzleOrm, transaction } from "~/components/database/index.server";

import { proofDatabase, transactionQueries } from "./presets";
import { write } from "./write-boundary";

const save = operation({
  label: "proof.write",
  input: z.object({ parentId: z.number(), fail: z.boolean().default(false) }),
  depends: { tx: transaction, orm: drizzleOrm },
  run: async ({ tx, orm }, { input, raise }) => {
    await tx.execute(orm.sql`INSERT INTO tx_proof_child(parent_id) VALUES (${input.parentId})`);
    if (input.fail) raise("StepRefused", {});
    return "saved";
  },
});

test("a deferred constraint error at COMMIT fails the call and leaves no saved row", async () => {
  const root = createScope({ presets: [proofDatabase] });
  await root.ready;
  const db = await root.resolve(database);
  const { sql } = await root.resolve(drizzleOrm);
  await db.execute(sql`CREATE TABLE tx_proof_parent(id int PRIMARY KEY)`);
  await db.execute(
    sql`CREATE TABLE tx_proof_child(parent_id int REFERENCES tx_proof_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
  );

  await expect(write(root, save, { rawInput: { parentId: 99 } })).rejects.toMatchObject({
    kind: "TeardownFailed",
  });
  expect(await db.execute(sql`SELECT * FROM tx_proof_child`)).toMatchObject({ rows: [] });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a thrown step rolls back all writes, before the dispatch returns", async () => {
  const root = createScope({ presets: [proofDatabase] });
  await root.ready;
  const db = await root.resolve(database);
  const { sql } = await root.resolve(drizzleOrm);
  await db.execute(sql`CREATE TABLE tx_proof_child(parent_id int)`);

  transactionQueries.length = 0;
  await expect(write(root, save, { rawInput: { parentId: 1, fail: true } })).rejects.toMatchObject({
    kind: "StepRefused",
  });
  expect(transactionQueries).toEqual(["BEGIN", "ROLLBACK"]);
  expect(await db.execute(sql`SELECT * FROM tx_proof_child`)).toMatchObject({ rows: [] });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a session resource belongs to the resolving child, not its request parent", async () => {
  let builds = 0;
  const ended: number[] = [];
  const probe = resource({
    label: "proof.sessionOwner",
    target: "session",
    factory: (_deps, { defer }) => {
      const id = ++builds;
      defer(() => {
        ended.push(id);
      });
      return id;
    },
  });
  const step = operation({ label: "proof.owner", depends: { probe }, run: ({ probe }) => probe });
  const root = createScope();
  const request = root.createSession();
  expect(request.resolve(probe)).toBe(1);

  const result = await request.settle(step, { signal: new AbortController().signal });
  expect(result).toEqual({ status: "success", value: 2 });
  expect(ended).toEqual([2]);
  expect(request.resolve(probe)).toBe(1);
  await request.close({ graceful: true });
  expect(ended).toEqual([2, 1]);
  await root.close({ graceful: true });
});

test("a read-only call resolves an idle transaction without BEGIN", async () => {
  const read = operation({
    label: "proof.readOnly",
    depends: { database, tx: transaction, orm: drizzleOrm },
    run: async ({ database, orm }) => database.execute(orm.sql`SELECT 1 AS value`),
  });
  const root = createScope({ presets: [proofDatabase] });
  await root.ready;

  transactionQueries.length = 0;
  await root.run(read, { signal: new AbortController().signal });
  expect(transactionQueries).toEqual([]);
  await root.close({ graceful: true });
});

test("commit then repeated ends and session defer execute no second end SQL", async () => {
  const call = operation({
    label: "proof.explicitCall",
    depends: { tx: transaction, save: save.controller },
    run: async ({ tx, save }) => {
      await save.run({ rawInput: { parentId: 1 } });
      await tx.commit();
      await tx.commit();
      await tx.rollback();
      return "saved";
    },
  });
  const root = createScope({ presets: [proofDatabase] });
  await root.ready;
  const db = await root.resolve(database);
  const { sql } = await root.resolve(drizzleOrm);
  await db.execute(sql`CREATE TABLE tx_proof_child(parent_id int)`);
  transactionQueries.length = 0;

  expect(await root.run(call, { signal: new AbortController().signal })).toBe("saved");
  expect(transactionQueries).toEqual(["BEGIN", "COMMIT"]);
  expect(await db.execute(sql`SELECT * FROM tx_proof_child`)).toMatchObject({
    rows: [{ parent_id: 1 }],
  });
  await root.close({ graceful: true });
  expect(transactionQueries).toEqual(["BEGIN", "COMMIT"]);
});

test("cancel mid-step runs exactly one deferred rollback", async () => {
  const written = Promise.withResolvers<void>();
  const hold = operation({
    label: "proof.hold",
    depends: { tx: transaction, orm: drizzleOrm },
    run: async ({ tx, orm }, { signal }) => {
      await tx.execute(orm.sql`INSERT INTO tx_proof_child VALUES (1)`);
      written.resolve();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    },
  });
  const root = createScope({ presets: [proofDatabase] });

  await root.ready;
  const db = await root.resolve(database);
  const { sql } = await root.resolve(drizzleOrm);
  await db.execute(sql`CREATE TABLE tx_proof_child(parent_id int)`);
  const stop = new AbortController();
  transactionQueries.length = 0;
  const running = root.settle(hold, { signal: stop.signal });
  await written.promise;
  stop.abort();
  expect(await running).toMatchObject({ status: "cancelled" });
  expect(transactionQueries).toEqual(["BEGIN", "ROLLBACK"]);
  expect(await db.execute(sql`SELECT * FROM tx_proof_child`)).toMatchObject({ rows: [] });
  await root.close({ graceful: true });
});

test("a query after either explicit end throws TransactionEnded without another SQL query", async () => {
  for (const end of ["commit", "rollback"] as const) {
    const root = createScope({ presets: [proofDatabase] });
    await root.ready;
    const call = operation({
      label: "proof.endedQuery",
      depends: { tx: transaction, orm: drizzleOrm },
      run: async ({ tx, orm }) => {
        await tx.execute(orm.sql`SELECT 1`);
        await tx[end]();
        await tx.execute(orm.sql`SELECT 2`);
      },
    });

    transactionQueries.length = 0;
    await expect(root.run(call, { signal: new AbortController().signal })).rejects.toMatchObject({
      kind: "TransactionEnded",
    });
    expect(transactionQueries).toEqual(["BEGIN", end === "commit" ? "COMMIT" : "ROLLBACK"]);
    await root.close({ graceful: true });
  }
});
