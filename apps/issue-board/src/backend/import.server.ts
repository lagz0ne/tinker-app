import { operation, tag } from "@tinker/core";
import { z } from "zod";

import { user } from "~/components/auth/index.server";
import { transaction, drizzleOrm } from "~/components/database/index.server";

import { issueRecord } from "@/contracts/issues";
import type { Errors } from "@/demo/errors";

import { issue, issueRowFields, team, teamMember } from "./board.schema.server";
import { fractionalIndex, csvParser } from "./modules";
import { lockTeamWrite, queueAlerts, fanOut, rowDeliveries } from "./team-write.server";

export const importFile = tag({ label: "import.file", parse: z.string().min(1) });
export const importTeam = tag({ label: "import.team", parse: z.string().min(1) });
export const importActor = tag({ label: "import.actor", parse: z.email() });

/** CSV is checked in full before any batch writes. Quoted cells retain line breaks. */
export const readImport = operation({
  label: "import.read",
  input: z.string(),
  depends: { csv: csvParser },
  run: async ({ csv }, { input, raise }) => {
    let records: string[][];
    try {
      records = csv.parse(input, { bom: true, skip_empty_lines: false });
    } catch (error) {
      return raise("BadInput", { reason: String(error) } satisfies Errors.Payload<"BadInput">);
    }

    const headers = records.shift() ?? [];

    if (new Set(headers).size !== headers.length) {
      return raise("BadInput", {
        reason: "CSV: duplicate header",
      } satisfies Errors.Payload<"BadInput">);
    }
    for (const name of ["ID", "Title"]) {
      if (!headers.includes(name)) {
        return raise("BadInput", {
          reason: `CSV: missing ${name}`,
        } satisfies Errors.Payload<"BadInput">);
      }
    }

    const seen = new Set<string>();

    return records
      .map((cells, index) => {
        if (cells.length !== headers.length) {
          return raise("BadInput", {
            reason: `CSV row ${index + 2}: wrong cell count`,
          } satisfies Errors.Payload<"BadInput">);
        }
        const row = Object.fromEntries(headers.map((name, column) => [name, cells[column]!]));
        const externalId = row.ID!.trim();

        if (externalId === "") {
          return raise("BadInput", {
            reason: "CSV: empty ID",
          } satisfies Errors.Payload<"BadInput">);
        }
        if (seen.has(externalId)) {
          return raise("BadInput", {
            reason: `CSV: repeated ID ${externalId}`,
          } satisfies Errors.Payload<"BadInput">);
        }
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
          return raise("BadInput", {
            reason: `CSV row ${index + 2}: unknown Status`,
          } satisfies Errors.Payload<"BadInput">);
        }
        const parsed = z
          .object({
            title: z.string().trim().min(1).max(200),
            priority: z.number().int().min(0).max(4),
          })
          .safeParse({ title: row.Title, priority });
        if (!parsed.success) {
          return raise("BadInput", {
            reason: `CSV row ${index + 2}: bad Title or Priority`,
          } satisfies Errors.Payload<"BadInput">);
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
  run: async ({ tx, orm, key, email }, { raise }) => {
    const { eq, and, sql } = orm;

    const [target] = await tx
      .select({ teamId: team.id, teamKey: team.key, id: user.id, name: user.name })
      .from(team)
      .innerJoin(teamMember, eq(teamMember.teamId, team.id))
      .innerJoin(user, eq(user.id, teamMember.userId))
      .where(and(eq(team.key, key), sql`lower(${user.email}) = ${email.toLowerCase()}`));

    if (!target) {
      return raise("NotTeamMember", {} satisfies Errors.Payload<"NotTeamMember">);
    }

    return target;
  },
});

const importRowInput = z.object({
  teamId: z.uuid(),
  actorId: z.string(),
  teamKey: z.string(),
  row: importBatchInput.shape.rows.element,
  assigneeId: z.string().nullable(),
});

export const readImportRow = operation({
  label: "import.readRow",
  input: importRowInput,
  depends: { tx: transaction, orm: drizzleOrm },
  run: async ({ tx, orm }, { input }) => {
    const { eq, and } = orm;

    const [current] = await tx
      .select(issueRowFields)
      .from(issue)
      .where(and(eq(issue.teamId, input.teamId), eq(issue.externalId, input.row.externalId)));

    const { row, assigneeId } = input;

    const unchanged =
      current !== undefined &&
      current.title === row.title &&
      current.description === row.description &&
      current.state === row.state &&
      current.priority === row.priority &&
      current.assigneeId === assigneeId;

    return { current: current ?? null, unchanged };
  },
});

export const placeImportRow = operation({
  label: "import.place",
  input: importRowInput.extend({ current: issueRecord.omit({ teamKey: true }).nullable() }),
  depends: { tx: transaction, orm: drizzleOrm, fractionalIndex },
  run: async ({ tx, orm, fractionalIndex }, { input }) => {
    const { eq, and, sql, asc } = orm;

    const [last] = await tx
      .select({ rank: issue.rank })
      .from(issue)
      .where(and(eq(issue.teamId, input.teamId), eq(issue.state, input.row.state)))
      .orderBy(sql`${issue.rank} collate "C" desc`, asc(issue.id))
      .limit(1);

    return input.current?.state === input.row.state
      ? input.current.rank
      : fractionalIndex.generateKeyBetween(last?.rank ?? null, null);
  },
});

export const createImportRow = operation({
  label: "import.create",
  input: importRowInput.extend({ rank: z.string() }),
  depends: { tx: transaction, orm: drizzleOrm },
  run: async ({ tx, orm }, { input, random, clock }) => {
    const { eq, sql } = orm;

    const { row, assigneeId, rank } = input;

    const [counter] = await tx
      .update(team)
      .set({ issueSeq: sql`${team.issueSeq} + 1` })
      .where(eq(team.id, input.teamId))
      .returning({ number: team.issueSeq });

    const [saved] = await tx
      .insert(issue)
      .values({
        id: random.uuid(),
        teamId: input.teamId,
        externalId: row.externalId,
        number: counter!.number,
        creatorId: input.actorId,
        title: row.title,
        description: row.description,
        state: row.state,
        priority: row.priority,
        assigneeId,
        rank,
        updatedAt: new Date(clock.currentTimeMillis()),
      })
      .returning(issueRowFields);

    return saved!;
  },
});

export const updateImportRow = operation({
  label: "import.update",
  input: importRowInput.extend({ id: z.uuid(), rank: z.string() }),
  depends: { tx: transaction, orm: drizzleOrm },
  run: async ({ tx, orm }, { input, clock }) => {
    const { eq, sql } = orm;

    const { row, assigneeId, rank } = input;
    // The team row lock covers the earlier read and this update; no version can race.

    const [saved] = await tx
      .update(issue)
      .set({
        title: row.title,
        description: row.description,
        state: row.state,
        priority: row.priority,
        assigneeId,
        rank,
        updatedAt: new Date(clock.currentTimeMillis()),
        version: sql`${issue.version} + 1`,
      })
      .where(eq(issue.id, input.id))
      .returning(issueRowFields);

    return saved!;
  },
});

export const saveImportRow = operation({
  label: "import.saveRow",
  input: importRowInput,
  depends: {
    read: readImportRow.controller,
    place: placeImportRow.controller,
    create: createImportRow.controller,
    update: updateImportRow.controller,
  },
  run: async ({ read, place, create, update }, { input }) => {
    const { current, unchanged } = await read.run({ input });

    if (unchanged) return null;

    const rank = await place.run({ input: { ...input, current } });

    const saved = current
      ? await update.run({ input: { ...input, id: current.id, rank } })
      : await create.run({ input: { ...input, rank } });

    return { ...saved, teamKey: input.teamKey };
  },
});

export const importBatch = operation({
  label: "import.batch",
  input: importBatchInput,
  depends: {
    target: importTarget.controller,
    lock: lockTeamWrite.controller,
    save: saveImportRow.controller,
    alerts: queueAlerts.controller,
    fanDeliveries: rowDeliveries.controller,
    publish: fanOut.controller,
  },
  run: async (
    { target, lock, save, alerts, fanDeliveries, publish },
    { input, random, signal, raise },
  ) => {
    const writer = await target.run();

    const locked = await lock.run({ input: { teamId: writer.teamId, actorId: writer.id } });

    const known = locked.members;

    const ids = new Map<string, string | null>([
      ["", null],
      ...known.map((member): [string, string] => [member.email.toLowerCase(), member.id]),
    ]);

    let changed = 0;
    for (const row of input.rows) {
      signal.throwIfAborted();
      const assigneeId = ids.get(row.assignee);
      if (assigneeId === undefined) {
        return raise("InvalidAssignee", {} satisfies Errors.Payload<"InvalidAssignee">);
      }
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
          deliveries: fanDeliveries.run({
            input: {
              members: locked.members,
              change: { kind: "issue.upsert", issue: saved },
              actorId: writer.id,
            },
          }),
        },
      });
      changed += 1;
    }

    return { changed };
  },
});
