import { operation } from "@tinker/core";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { drizzlePg } from "~/components/drizzle-pg/index.server";
import type { Errors } from "~/components/errors";

import { notes } from "./pg-schema";

/** Adds a note in the call's transaction. The row type comes from the schema. */
export const addNote = operation({
  label: "notes.add",
  input: z.object({ title: z.string().min(1) }),
  depends: { tx: drizzlePg.tx },
  run: async ({ tx }, { input }) => {
    const [row] = await tx.insert(notes).values({ title: input.title }).returning();
    return row!;
  },
});

/** Adds two notes, then fails: the session rolls both back. */
export const addTwoThenFail = operation({
  label: "notes.addTwoThenFail",
  depends: { tx: drizzlePg.tx },
  run: async ({ tx }, { raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;
    await tx.insert(notes).values([{ title: "ghost 1" }, { title: "ghost 2" }]);
    return raise("Refused", { message: "test" });
  },
});

/** Two ops in one call share the one transaction: a subflow sees the parent's tx. */
export const addAndVote = operation({
  label: "notes.addAndVote",
  input: z.object({ title: z.string().min(1) }),
  depends: { tx: drizzlePg.tx, add: addNote },
  run: async ({ tx, add }, { input }) => {
    const row = await add.run({ input });
    await tx
      .update(notes)
      .set({ votes: sql`${notes.votes} + 1` })
      .where(eq(notes.id, row.id));
    return row.id;
  },
});

/** Reads outside any transaction, on the shared db. */
export const listNotes = operation({
  label: "notes.list",
  depends: { db: drizzlePg.db },
  run: async ({ db }) => db.select().from(notes).orderBy(asc(notes.id)),
});

/** Empties the table, so a shared Postgres starts each run clean. */
export const clearNotes = operation({
  label: "notes.clear",
  depends: { tx: drizzlePg.tx },
  run: async ({ tx }) => void (await tx.delete(notes)),
});
