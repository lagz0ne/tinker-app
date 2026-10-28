import { operation, resource } from "@tinker/core";
import { z } from "zod";

import type { Database } from "~/components/database-sqlite/index.server";
import { transaction } from "~/components/database-sqlite/index.server";
import { raise } from "~/components/errors";
import type { Sync } from "~/components/sync-sqlite/envelopes";

import bumpStream from "./queries/bump_stream.sql";
import insertEvent from "./queries/insert_event.sql";
import insertStream from "./queries/insert_stream.sql";
import readEvents from "./queries/read_events.sql";
import readExecution from "./queries/read_execution.sql";
import readStream from "./queries/read_stream.sql";
import writeResult from "./queries/write_result.sql";

/** One stored execution row: the two JSON columns read back as values. */
type Execution = {
  id: string;
  stream: string;
  notification: unknown;
  result: unknown;
};

/**
 * Snapshots read a cursor without a row lock. Writers hold the process's one write turn and a
 * `BEGIN IMMEDIATE` transaction until their records and events commit together.
 */
export const eventHistory = resource({
  label: "sync.history",
  factory: () => ({
    async read(tx: Database.SessionTransaction, id: string) {
      const row = readStream.runSync(await tx.db(), { id });

      if (!row) raise("StreamMissing", {});

      return row.revision;
    },
    async lock(tx: Database.SessionTransaction, id: string) {
      const connection = await tx.db();

      // No `FOR UPDATE`: the write turn already makes this the only writer of the stream row.
      insertStream.runSync(connection, { id });

      const row = readStream.runSync(connection, { id });

      if (!row) raise("StreamMissing", {});

      return row.revision;
    },
    async find(
      tx: Database.SessionTransaction,
      id: string,
      owner: string,
    ): Promise<Execution | undefined> {
      const row = readExecution.runSync(await tx.db(), { id });

      if (row && row.stream !== owner) raise("StreamDenied", {});

      if (!row) return undefined;

      return {
        id: row.id,
        stream: row.stream,
        notification: row.notification === null ? null : JSON.parse(row.notification),
        result: row.result === null ? null : JSON.parse(row.result),
      };
    },
    async append(
      tx: Database.SessionTransaction,
      owner: string,
      executionId: string,
      payloads: Sync.Payload[],
    ) {
      const connection = await tx.db();

      const row = bumpStream.runSync(connection, { count: payloads.length, id: owner });

      if (!row) raise("StreamMissing", {});

      const first = row.revision - payloads.length + 1;

      // The committed insert wakes every listener; a rolled-back append wakes nobody.
      payloads.forEach((payload, offset) => {
        insertEvent.runSync(connection, {
          stream: owner,
          revision: first + offset,
          execution_id: executionId,
          payload: JSON.stringify(payload),
        });
      });

      for (const payload of payloads) {
        if (payload.kind !== "result") continue;

        writeResult.runSync(connection, {
          id: executionId,
          result: JSON.stringify(payload.result ?? null),
        });
      }

      await tx.notify("start_sync", "sync_event");
    },
    /** The events a replay frame reads, the replacement for the Postgres `event` table. */
    async events(
      tx: Database.SessionTransaction,
      owner: string,
      after: number,
    ): Promise<Sync.Event[]> {
      const rows = readEvents.runSync(await tx.db(), { stream: owner, after });

      const events: Sync.Event[] = [];

      for (const row of rows) {
        events.push({
          stream: row.stream,
          revision: row.revision,
          executionId: row.execution_id,
          payload: JSON.parse(row.payload) as Sync.Payload,
        });
      }

      return events;
    },
  }),
});

/** Better Auth awaits this idempotent insert after its own user transaction. */
export const createAccountStream = operation({
  label: "sync.accountCreated",
  input: z.strictObject({ accountId: z.string().min(1) }),
  depends: { transaction },
  run: async ({ transaction }, { input }) => {
    insertStream.runSync(await transaction.db(), { id: input.accountId });
  },
});
