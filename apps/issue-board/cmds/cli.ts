import { createScope } from "@tinker/core";

import { defineMain, mainErrorCode, checkClosed } from "~/base/main";
import { databaseUrl } from "~/components/database/index.server";

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
  try {
    const root = createScope({
      signal,
      observe: { history: 32, log: (entry) => stdout.write(`${JSON.stringify(entry)}\n`) },
      tags: [
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
    const closed = root.run(runImport, { signal }).then(
      async (result) => {
        const ended = await root.close({ graceful: true });
        checkClosed(ended);
        stdout.write(`Imported ${result.rows} rows; ${result.changed} changed.\n`);
        exit(0);
      },
      async (error) => {
        stderr.write(`import failed: ${String(error)}\n`);
        await root.close();
        if (signal.aborted && error === signal.reason) return;

        const kind =
          error && typeof error === "object" && "kind" in error ? String(error.kind) : "";
        const code = ["BadInput", "InvalidAssignee", "NotTeamMember", "TeamChanged"].includes(kind)
          ? 65
          : 1;
        exit(code, error);
        if (code === 1) throw error;
      },
    );
    return { closed };
  } catch (error) {
    stderr.write(`import start failed: ${String(error)}\n`);
    const code = mainErrorCode(error);
    exit(code, error);
    if (code === 1) throw error;
    return { closed: Promise.resolve() };
  }
});
