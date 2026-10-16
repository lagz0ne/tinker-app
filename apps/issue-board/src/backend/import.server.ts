import { operation, tag } from "@tinker/core";
import { z } from "zod";

import { user } from "~/components/auth/index.server";
import { database, drizzleOrm } from "~/components/database/index.server";
import { eventHistory, execution } from "~/components/sync/index.server";

import { raise } from "@/demo/errors";

import { issue, issueFields, team, teamMember, mailOutbox } from "./board.schema.server";
import { fractionalIndex, files, csvParser } from "./modules";

export const importFile = tag<string>({ label: "import.file", parse: z.string().min(1) });
export const importTeam = tag<string>({ label: "import.team", parse: z.string().min(1) });
export const importActor = tag<string>({ label: "import.actor", parse: z.email() });

/** CSV is checked in full before any batch writes. Quoted cells retain line breaks. */
export const readImport = operation({
  label: "import.read",
  input: z.string(),
  depends: { csv: csvParser },
  run: async ({ csv }, { input }) => {
    let records: string[][];
    try {
      records = csv.parse(input, { bom: true, skip_empty_lines: false });
    } catch (error) {
      raise("BadInput", { reason: String(error) });
    }
    const headers = records.shift() ?? [];

    if (new Set(headers).size !== headers.length) {
      raise("BadInput", { reason: "CSV: duplicate header" });
    }
    for (const name of ["ID", "Title"]) {
      if (!headers.includes(name)) raise("BadInput", { reason: `CSV: missing ${name}` });
    }

    const seen = new Set<string>();
    return records
      .map((cells, index) => {
        if (cells.length !== headers.length) {
          raise("BadInput", { reason: `CSV row ${index + 2}: wrong cell count` });
        }
        const row = Object.fromEntries(headers.map((name, column) => [name, cells[column]!]));
        const externalId = row.ID!.trim();

        if (externalId === "") raise("BadInput", { reason: "CSV: empty ID" });
        if (seen.has(externalId)) raise("BadInput", { reason: `CSV: repeated ID ${externalId}` });
        seen.add(externalId);
        return { row, externalId, index };
      })
      .map(({ row, externalId, index }) => {
        const states: Record<string, "backlog" | "todo" | "in_progress" | "done" | "canceled"> = {
          Backlog: "backlog",
          Todo: "todo",
          "In Progress": "in_progress",
          Done: "done",
          Canceled: "canceled",
        };
        const priorities: Record<string, number> = {
          "No priority": 0,
          Urgent: 1,
          High: 2,
          Medium: 3,
          Low: 4,
        };
        const { Status, Priority, Description, Assignee } = Object.assign(
          { Status: "Backlog", Priority: "No priority", Description: "", Assignee: "" },
          row,
        );
        const state = states[Status];

        const priority = priorities[Priority] ?? Number(Priority);
        if (!Object.hasOwn(states, Status)) {
          raise("BadInput", { reason: `CSV row ${index + 2}: unknown Status` });
        }
        const parsed = z
          .object({
            title: z.string().trim().min(1).max(200),
            priority: z.number().int().min(0).max(4),
          })
          .safeParse({ title: row.Title, priority });
        if (!parsed.success) {
          raise("BadInput", { reason: `CSV row ${index + 2}: bad Title or Priority` });
        }
        return {
          externalId,
          title: parsed.data.title,
          description: Description,
          state,
          priority: parsed.data.priority,
          assignee: Assignee.trim().toLowerCase(),
        };
      });
  },
});

export const importBatch = operation({
  label: "import.batch",
  input: z.object({
    rows: z
      .array(
        z.object({
          externalId: z.string().min(1),
          title: z.string().min(1).max(200),
          description: z.string(),
          state: z.enum(["backlog", "todo", "in_progress", "done", "canceled"]),
          priority: z.number().int().min(0).max(4),
          assignee: z.string(),
        }),
      )
      .min(1)
      .max(100),
  }),
  depends: {
    database,
    orm: drizzleOrm,
    history: eventHistory,
    fractionalIndex,
    key: importTeam,
    actor: importActor,
  },
  run: async (
    { database, orm, history, fractionalIndex, key, actor },
    { input, random, clock, signal },
  ) => {
    const { eq, and, sql, asc } = orm;
    return database.transaction(async (tx) => {
      const [board] = await tx.select().from(team).where(eq(team.key, key));

      if (!board) raise("BadInput", { reason: "Import team missing" });
      const members = await tx
        .select({ id: user.id, email: user.email, name: user.name })
        .from(teamMember)
        .innerJoin(user, eq(user.id, teamMember.userId))
        .where(eq(teamMember.teamId, board.id))
        .orderBy(sql`${user.id} collate "C"`);
      const writer = members.find((member) => member.email.toLowerCase() === actor.toLowerCase());
      if (!writer) raise("NotTeamMember", {});
      for (const member of members) await history.lock(tx, member.id);
      const current = await tx.select().from(teamMember).where(eq(teamMember.teamId, board.id));
      if (current.some((member) => !members.some((locked) => locked.id === member.userId))) {
        raise("TeamChanged", {});
      }
      await tx.select().from(team).where(eq(team.id, board.id)).for("no key update");
      const assignees = new Map<string, string | null>([
        ["", null],
        ...members.map((member): [string, string] => [member.email.toLowerCase(), member.id]),
      ]);

      let changed = 0;
      for (const row of input.rows) {
        signal.throwIfAborted();
        const assigneeId = assignees.get(row.assignee);
        if (assigneeId === undefined) {
          raise("InvalidAssignee", {});
        }
        await tx
          .select()
          .from(issue)
          .where(and(eq(issue.teamId, board.id), eq(issue.externalId, row.externalId)))
          .then(async ([old]) => {
            const same =
              old &&
              Object.entries({
                title: row.title,
                description: row.description,
                state: row.state,
                priority: row.priority,
                assigneeId,
              }).every(([field, value]) => old[field as keyof typeof old] === value);
            if (same) return;

            const rank = await tx
              .select({ rank: issue.rank })
              .from(issue)
              .where(and(eq(issue.teamId, board.id), eq(issue.state, row.state)))
              .orderBy(sql`${issue.rank} collate "C" desc`, asc(issue.id))
              .limit(1)
              .then(([last]) =>
                old?.state === row.state
                  ? old.rank
                  : fractionalIndex.generateKeyBetween(last?.rank ?? null, null),
              );
            const values = {
              title: row.title,
              description: row.description,
              state: row.state,
              priority: row.priority,
              assigneeId,
              rank,
              updatedAt: new Date(clock.currentTimeMillis()),
            };
            const id = old?.id ?? random.uuid();
            if (old) {
              await tx
                .update(issue)
                .set({ ...values, version: sql`${issue.version} + 1` })
                .where(eq(issue.id, id));
            } else {
              const [counter] = await tx
                .update(team)
                .set({ issueSeq: sql`${team.issueSeq} + 1` })
                .where(eq(team.id, board.id))
                .returning({ number: team.issueSeq });
              await tx.insert(issue).values({
                ...values,
                id,
                teamId: board.id,
                externalId: row.externalId,
                number: counter!.number,
                creatorId: writer.id,
              });
            }
            const [saved] = await tx
              .select(issueFields)
              .from(issue)
              .innerJoin(team, eq(team.id, issue.teamId))
              .where(eq(issue.id, id));
            const executionId = random.uuid();
            await tx.execute(sql`
          INSERT INTO ${mailOutbox} ("to", subject, text, dedupe_key)
          SELECT ${user.email}, ${`${saved!.teamKey}-${saved!.number}: ${saved!.title}`}, ${`${writer.name}: issue import.`},
            ${executionId} || ':' || ${user.id}
          FROM ${teamMember} INNER JOIN ${user} ON ${teamMember.userId} = ${user.id}
          WHERE ${teamMember.teamId} = ${board.id} AND ${user.id} <> ${writer.id}
          ON CONFLICT (dedupe_key) DO NOTHING
        `);
            await tx.insert(execution).values({ id: executionId, stream: writer.id });
            for (const member of members) {
              await history.append(tx, member.id, executionId, [
                { kind: "change", change: { kind: "issue.upsert", issue: saved! } },
                ...(member.id === writer.id
                  ? [
                      {
                        kind: "result" as const,
                        result: { kind: "complete" as const, action: "issue" as const },
                      },
                    ]
                  : []),
              ]);
            }
            changed += 1;
          });
      }
      return { changed };
    });
  },
});

export const runImport = operation({
  label: "import.run",
  depends: { files, path: importFile, read: readImport.controller, batch: importBatch.controller },
  run: async ({ files, path, read, batch }, { signal, log }) => {
    const rows = await read.run({
      rawInput: await files.readFile(path, { encoding: "utf8", signal }),
    });
    let changed = 0;
    for (let offset = 0; offset < rows.length; offset += 100) {
      signal.throwIfAborted();
      const result = await batch.run({ rawInput: { rows: rows.slice(offset, offset + 100) } });
      changed += result.changed;
      log("import.batch", { rows: Math.min(100, rows.length - offset), changed: result.changed });
    }
    return { rows: rows.length, changed };
  },
});
