import { operation } from "@tinker/core";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { drizzleSqlite } from "~/components/drizzle-sqlite/index.server";
import type { Errors } from "~/components/errors";

import { notes } from "./sqlite-schema";

/** Adds a note in the call's transaction. The row type comes from the schema. */
export const addNote = operation({
  label: "snotes.add",
  input: z.object({ title: z.string().min(1) }),
  depends: { tx: drizzleSqlite.tx },
  run: async ({ tx }, { input }) => {
    const [row] = await tx.insert(notes).values({ title: input.title }).returning();
    return row!;
  },
});

/** Adds two notes, then fails: the session rolls both back. */
export const addTwoThenFail = operation({
  label: "snotes.addTwoThenFail",
  depends: { tx: drizzleSqlite.tx },
  run: async ({ tx }, { raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;
    await tx.insert(notes).values([{ title: "ghost 1" }, { title: "ghost 2" }]);
    return raise("Refused", { message: "test" });
  },
});

/** Two ops in one call share the one transaction: a subflow sees the parent's tx. */
export const addAndVote = operation({
  label: "snotes.addAndVote",
  input: z.object({ title: z.string().min(1) }),
  depends: { tx: drizzleSqlite.tx, add: addNote },
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
  label: "snotes.list",
  depends: { db: drizzleSqlite.db },
  run: async ({ db }) => db.select().from(notes).orderBy(asc(notes.id)),
});

/** Empties the table. */
export const clearNotes = operation({
  label: "snotes.clear",
  depends: { tx: drizzleSqlite.tx },
  run: async ({ tx }) => void (await tx.delete(notes)),
});
