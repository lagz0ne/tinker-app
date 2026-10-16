import { createScope, type Scope } from "@tinker/core";

import { databaseUrl } from "~/components/database/index.server";

import { importFile, importTeam, importActor, runImport } from "@/backend/import.server";

/**
 * The host owns args, env, output, and stop. Importing this command starts nothing.
 * @param input - From the host; why: bind args, settings, output, and stop.
 */
export default async function main({
  env,
  args,
  signal,
  stdout,
  stderr,
  presets,
}: {
  env: Readonly<Record<string, string | undefined>>;
  args: readonly string[];
  signal: AbortSignal;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  presets?: Scope.Preset[];
}) {
  const options = {} as Record<string, string>;

  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (!["--file", "--team", "--actor"].includes(key) || !value || Object.hasOwn(options, key)) {
      throw new Error("Usage: cli --file issues.csv --team ENG --actor ada@example.test");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== 3) {
    throw new Error("Usage: cli --file issues.csv --team ENG --actor ada@example.test");
  }
  const root = createScope({
    signal,
    presets,
    observe: { history: 32, log: (entry) => stdout.write(`${JSON.stringify(entry)}\n`) },
    tags: [
      env.DATABASE_URL !== undefined && databaseUrl(new URL(env.DATABASE_URL)),
      importFile(options["--file"]!),
      importTeam(options["--team"]!),
      importActor(options["--actor"]!),
    ],
  });
  await root.ready;
  const closed = root.run(runImport, { signal }).then(
    async (result) => {
      const ended = await root.close({ graceful: true });
      if (ended.status === "failed") throw ended.error;
      if (ended.teardownErrors?.length) throw ended.teardownErrors[0];
      stdout.write(`Imported ${result.rows} rows; ${result.changed} changed.\n`);
    },
    async (error) => {
      stderr.write(`import failed: ${String(error)}\n`);
      await root.close();
      throw error;
    },
  );
  return { closed };
}
