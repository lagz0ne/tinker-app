import { createScope } from "@tinker/core";

import { defineMain } from "~/base/main";
import {
  databaseSetup,
  databaseMigrationTimeout,
  databaseUrl,
} from "~/components/database/index.server";

import { importFile, importTeam, importActor } from "@/backend/import.server";
import { runImport } from "@/transport/import-runner.server";

/** The host owns args, env, output, and clean exit. */
// oxlint-disable-next-line complexity -- Native entry keeps CLI argument checks, typed config bindings, and startup cleanup together.
export default defineMain(async ({ env, args, signal, stdout, stderr, exit }) => {
  const options = {} as Record<string, string>;

  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (!["--file", "--team", "--actor"].includes(key) || !value || Object.hasOwn(options, key)) {
      stderr.write("Usage: cli --file issues.csv --team ENG --actor ada@example.test\n");
      exit(64);
      return { closed: Promise.resolve() };
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 3) {
    stderr.write("Usage: cli --file issues.csv --team ENG --actor ada@example.test\n");
    exit(64);
    return { closed: Promise.resolve() };
  }
  const root = createScope({
    signal,
    extensions: [databaseSetup],
    // Room for the 60 s max migration-owner wait, plus connect and DDL.
    startTimeout: 70_000,
    observe: { history: 32, log: (entry) => stdout.write(`${JSON.stringify(entry)}\n`) },
    tags: [
      env.DATABASE_MIGRATION_TIMEOUT_MS !== undefined &&
        databaseMigrationTimeout(Number(env.DATABASE_MIGRATION_TIMEOUT_MS)),
      env.DATABASE_URL !== undefined && databaseUrl(new URL(env.DATABASE_URL)),
      importFile(options["--file"]!),
      importTeam(options["--team"]!),
      importActor(options["--actor"]!),
    ],
  });
  try {
    await root.ready;
    root.resolve(databaseUrl);
  } catch (error) {
    await root.close();
    throw error;
  }
  const closed = root
    .run(runImport, { signal })
    .then(
      async (result) => {
        // The host fails the run with this result's failure; only a clean close reports rows.
        const ended = await root.close({ graceful: true });
        if (ended.status === "failed" || ended.teardownErrors?.length) return ended;
        stdout.write(`Imported ${result.rows} rows; ${result.changed} changed.\n`);
        exit(0);
        return ended;
      },
      // oxlint-disable-next-line complexity -- The command maps each typed import failure to its exit code.
      async (error) => {
        await root.close();
        if (signal.aborted && error === signal.reason) return;

        const kind =
          error && typeof error === "object" && "kind" in error ? String(error.kind) : "";

        const code =
          kind === "TeamChanged"
            ? 75
            : ["BadInput", "InvalidAssignee", "NotTeamMember"].includes(kind)
              ? 65
              : 1;

        exit(code, error);
      },
    )
    .catch((error) => {
      exit(1, error);
    });
  return { closed };
});
