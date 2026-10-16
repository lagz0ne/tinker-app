import { operation, tag } from "@tinker/core";
import { z } from "zod";

import { user } from "~/components/auth/index.server";
import { transaction, drizzleOrm } from "~/components/database/index.server";

import type { Issue } from "@/contracts/issues";
import { raise } from "@/demo/errors";

import { issue, issueRowFields, team, teamMember } from "./board.schema.server";
import { fractionalIndex, csvParser } from "./modules";
import { lockTeamWrite, queueAlerts, fanOut, rowDeliveries } from "./team-write.server";

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

export const importBatchInput = z.object({
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
});

export const importTarget = operation({
  label: "import.target",
  depends: { tx: transaction, orm: drizzleOrm, key: importTeam, email: importActor },
  run: async ({ tx, orm, key, email }) => {
    const { eq, and, sql } = orm;
    const [target] = await tx
      .select({ teamId: team.id, teamKey: team.key, id: user.id, name: user.name })
      .from(team)
      .innerJoin(teamMember, eq(teamMember.teamId, team.id))
      .innerJoin(user, eq(user.id, teamMember.userId))
      .where(and(eq(team.key, key), sql`lower(${user.email}) = ${email.toLowerCase()}`));
    if (!target) raise("NotTeamMember", {});
    return target;
  },
});

export const importAssignees = operation({
  label: "import.assignees",
  input: z.string(),
  depends: { tx: transaction, orm: drizzleOrm },
  run: async ({ tx, orm }, { input }) => {
    const { eq } = orm;
    return tx
      .select({ id: user.id, email: user.email })
      .from(teamMember)
      .innerJoin(user, eq(user.id, teamMember.userId))
      .where(eq(teamMember.teamId, input));
  },
});

export const saveImportRow = operation({
  label: "import.saveRow",
  input: (raw: unknown) =>
    raw as {
      teamId: string;
      actorId: string;
      teamKey: string;
      row: import("zod").z.infer<typeof importBatchInput>["rows"][number];
      assigneeId: string | null;
    },
  depends: { tx: transaction, orm: drizzleOrm, fractionalIndex },
  run: async ({ tx, orm, fractionalIndex }, { input, random, clock }) => {
    const { eq, and, sql, asc } = orm;
    const { row, assigneeId } = input;
    return tx
      .select()
      .from(issue)
      .where(and(eq(issue.teamId, input.teamId), eq(issue.externalId, row.externalId)))
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
        if (same) return null;

        const rank = await tx
          .select({ rank: issue.rank })
          .from(issue)
          .where(and(eq(issue.teamId, input.teamId), eq(issue.state, row.state)))
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
        let saved: Omit<Issue, "teamKey">;
        if (old) {
          const rows = await tx
            .update(issue)
            .set({ ...values, version: sql`${issue.version} + 1` })
            .where(eq(issue.id, id))
            .returning(issueRowFields);
          saved = rows[0]!;
        } else {
          const [counter] = await tx
            .update(team)
            .set({ issueSeq: sql`${team.issueSeq} + 1` })
            .where(eq(team.id, input.teamId))
            .returning({ number: team.issueSeq });
          const rows = await tx
            .insert(issue)
            .values({
              ...values,
              id,
              teamId: input.teamId,
              externalId: row.externalId,
              number: counter!.number,
              creatorId: input.actorId,
            })
            .returning(issueRowFields);
          saved = rows[0]!;
        }
        return { ...saved, teamKey: input.teamKey };
      });
  },
});

export const importBatch = operation({
  label: "import.batch",
  input: importBatchInput,
  depends: {
    target: importTarget.controller,
    lock: lockTeamWrite.controller,
    assignees: importAssignees.controller,
    save: saveImportRow.controller,
    alerts: queueAlerts.controller,
    publish: fanOut.controller,
  },
  run: async ({ target, lock, assignees, save, alerts, publish }, { input, random, signal }) => {
    const writer = await target.run();
    const locked = await lock.run({ input: { teamId: writer.teamId, actorId: writer.id } });
    const known = input.rows.some((row) => row.assignee !== "")
      ? await assignees.run({ input: writer.teamId })
      : [];
    const ids = new Map<string, string | null>([
      ["", null],
      ...known.map((member): [string, string] => [member.email.toLowerCase(), member.id]),
    ]);

    let changed = 0;
    for (const row of input.rows) {
      signal.throwIfAborted();
      const assigneeId = ids.get(row.assignee);
      if (assigneeId === undefined) raise("InvalidAssignee", {});
      const saved = await save.run({
        input: {
          teamId: writer.teamId,
          actorId: writer.id,
          teamKey: writer.teamKey,
          row,
          assigneeId,
        },
      });
      if (!saved) continue;

      const executionId = random.uuid();
      await alerts.run({
        input: {
          teamId: writer.teamId,
          actorId: writer.id,
          executionId,
          subject: `${saved.teamKey}-${saved.number}: ${saved.title}`,
          text: `${writer.name}: issue import.`,
        },
      });
      await publish.run({
        input: {
          executionId,
          owner: writer.id,
          deliveries: rowDeliveries(
            locked.members,
            { kind: "issue.upsert", issue: saved },
            writer.id,
          ),
        },
      });
      changed += 1;
    }
    return { changed };
  },
});
