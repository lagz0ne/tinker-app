import assert from "node:assert/strict";
import { cp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Copy the app and replace only its native data sources; the installed base stays untouched. */
export async function copyProofApp(source, target) {
  for (const name of [
    "src",
    "cmds",
    "tinker",
    "tests",
    "drizzle",
    "package.json",
    "vite.config.ts",
    "tsconfig.json",
    "components.json",
  ]) {
    await cp(join(source, name), join(target, name), { recursive: true });
  }

  await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");

  const databaseFile = join(target, "tinker/components/database/database.server.ts");
  const database = await readFile(databaseFile, "utf8");
  const start = database.indexOf("export const database = resource({");
  const end = database.indexOf("export const migrate = operation({");
  assert.ok(start >= 0 && end > start, "the app declares its database before migrations");

  await writeFile(
    databaseFile,
    database
      .slice(0, start)
      .replace('import type { PoolClient } from "pg";\n', "")
      .replace(
        'import { postgres, drizzlePostgres, drizzlePgCore, drizzleMigrator } from "./modules";',
        'import { drizzlePgCore, drizzleMigrator } from "./modules";',
      ) +
      `export const database = resource({
    label: "proof.database",
    factory: async (_deps, { defer }): Promise<Database.Handle> => {
      const [{ PGlite }, { drizzle }] = await Promise.all([
        import("@electric-sql/pglite"), import("drizzle-orm/pglite"),
      ]);
      const client = await PGlite.create();
      defer(() => client.close());
      const handle = Object.assign(drizzle({ client }), {
        listen: async (channel: string, wake: (payload: string) => void) => client.listen(channel, wake),
      });
      let previous = Promise.resolve();
      return Object.assign(handle, {
        async checkout(guard?: Database.QueryGuard) {
          const released = Promise.withResolvers<void>();
          const connection = new Proxy(client, {
            get(target, key) {
              if (key === "release") return released.resolve;
              if (key === "query") return target.query.bind(target);
              return Reflect.get(target, key, target);
            },
          }) as typeof client & { release(broken?: boolean): void };
          return leaseFrom(async () => {
            const before = previous;
            previous = released.promise;
            await before;
            return connection;
          }, drizzle, guard);
        },
      });
    },
  });\n` +
      database.slice(end),
  );

  const mailFile = join(target, "tinker/components/mail/mail.server.ts");
  const mail = await readFile(mailFile, "utf8");
  const sender = mail.indexOf("export const mail = resource({");
  const send = mail.indexOf("export const sendMail = operation({");
  assert.ok(sender >= 0 && send > sender, "the app declares its mail client before sends");

  await writeFile(
    mailFile,
    mail.slice(0, sender).replace('import { smtp } from "./modules";\n', "") +
      `export const mail = resource({
    label: "proof.mail",
    factory: async (): Promise<Mail.Sender> => ({ send: async () => {} }),
  });\n` +
      mail.slice(send),
  );
}

/** Child-process inputs supplied by the host to the command; component tests bind tags directly. */
export const proofEnv = {
  PUBLIC_ORIGIN: "http://localhost:4318",
  AUTH_SECRET: "local-proof-only-secret-with-thirty-two-letters",
  DATABASE_URL: "postgres://proof",
  SMTP_URL: "smtp://proof:25",
  OTEL_SERVICE_NAME: "proof",
  SMTP_FROM: "proof@example.com",
  VICTORIA_TRACES_URL: "http://127.0.0.1:1/insert/opentelemetry/v1/traces",
  VICTORIA_LOGS_URL: "http://127.0.0.1:1/insert/jsonline",
};

/** The proof makes the same explicit standalone mail edit the user writes by hand. */
export async function wireProofMail(consumer) {
  const path = join(consumer, "cmds/server.ts");
  const main = await readFile(path, "utf8");
  assert.ok(main.includes("extensions: [startRequests]"));
  assert.ok(main.includes("backendStop(appStop),"));
  await writeFile(
    path,
    'import { mailStartup, smtpUrl, mailFrom } from "~/components/mail/index.server";\n' +
      main
        .replace("extensions: [startRequests]", "extensions: [startRequests, mailStartup]")
        .replace(
          "backendStop(appStop),",
          `backendStop(appStop),
      env.SMTP_URL !== undefined && smtpUrl(new URL(env.SMTP_URL)),
      env.SMTP_FROM !== undefined && mailFrom(env.SMTP_FROM),`,
        ),
  );
}

/** A built command must reject before serving when its required binding is omitted. */
export const missingMailChild = `
import assert from "node:assert/strict";
const { default: main } = await import("./dist/server/server.js");
const stop = new AbortController();
let code;
let reason;
const app = await main({ env: process.env, args: [], signal: stop.signal, stdout: process.stdout, stderr: process.stderr, exit(value, error) { code=value; reason=error; stop.abort(error); } });
await app.closed;
assert.equal(code, 78);
assert.equal(reason.kind, "MissingTag");
assert.equal(reason.payload.label, "mail.from");
console.log("PASS: command startup rejects MissingTag mail.from before serving.");
`;

/**
 * The toolchain block `tinker add` printed, as `file -> lines`, read from its stdout alone.
 * @param {string} output - From `tinker add`; why: the printed lines are all the user gets.
 */
export function printedToolchain(output) {
  const lines = output.split("\n");
  const start = lines.indexOf("Paste into your toolchain (tinker add writes no config):");
  assert.ok(start >= 0, "tinker add prints a toolchain block");

  const files = new Map();
  let file;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("  ")) files.get(file).push(line.slice(2));
    else if (/^[\w./-]+:$/.test(line)) files.set((file = line.slice(0, -1)), []);
    else break;
  }
  return files;
}

/**
 * Merge one printed JSON line (`"key": value`) into a JSON value, objects key by key.
 * @param {object} into - From pasteToolchain; why: the parsed file.
 * @param {object} line - From pasteToolchain; why: the printed fragment, parsed.
 */
function mergeJson(into, line) {
  for (const [key, value] of Object.entries(line)) {
    const both = [into[key], value].every((item) => item && typeof item === "object");
    into[key] = both && !Array.isArray(value) ? mergeJson({ ...into[key] }, value) : value;
  }
  return into;
}

/**
 * Paste the printed lines as a person would: a JSON line merges into its JSON file, an `import`
 * goes on top of a config, `plugins: [x, ...]` puts `x` first in the plugins, any other
 * `key: value` goes into `defineConfig({`, and a new file is the lines themselves.
 * @param {string} consumer - From the proof; why: the app the user pastes into.
 * @param {Map<string, string[]>} toolchain - From printedToolchain; why: the printed lines only.
 */
export async function pasteToolchain(consumer, toolchain) {
  for (const [file, lines] of toolchain) {
    const path = join(consumer, file);
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) {
      await writeFile(path, `${lines.join("\n")}\n`);
    } else if (file.endsWith(".json")) {
      const value = lines.reduce((json, line) => mergeJson(json, JSON.parse(`{${line}}`)), {
        ...JSON.parse(text),
      });
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
    } else {
      let source = text;
      for (const line of lines) {
        const plugin = line.match(/^plugins: \[(.+), \.\.\.\]$/);
        if (line.startsWith("import ")) source = `${line}\n${source}`;
        else if (plugin) source = source.replace("plugins: [", `plugins: [${plugin[1]}, `);
        else source = source.replace("defineConfig({", `defineConfig({\n  ${line},`);
      }
      assert.notEqual(source, text, `${file}: the printed lines change it`);
      await writeFile(path, source);
    }
  }
}

/** A user's own database test: migrate the copied migrations by default, then notify and hear it. */
export const sqliteAppTest = `import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createScope, operation } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import {
  database,
  databaseFolder,
  databaseUrl,
  migrate,
  transaction,
} from "~/components/database-sqlite/index.server";

test("the copied SQLite set migrates, and a committed notify is heard", async () => {
  const home = await mkdtemp(join(tmpdir(), "sqlite-app-"));
  const file = join(home, "app.db");
  // No migrations folder binding: the default, \`sqlite/migrations\`, is where tinker add put them.
  const app = fileURLToPath(new URL("..", import.meta.url));
  const root = createScope({ tags: [databaseUrl(pathToFileURL(file)), databaseFolder(app)] });

  await root.run(migrate);
  const db = await root.resolve(database);
  const heard: string[] = [];
  const stop = await db.listen("app_proof", (payload) => heard.push(payload), () => {});
  const save = operation({
    label: "app.proofNotify",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      await tx.notify("app_proof", "wake");
    },
  });
  await root.settle(save, { signal: new AbortController().signal });
  while (heard.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  stop();
  await root.close({ graceful: true });

  const reader = new DatabaseSync(file);
  const rows = reader.prepare("SELECT name FROM start_migrations ORDER BY name").all();
  reader.close();
  await rm(home, { recursive: true, force: true });

  expect(heard).toEqual(["wake"]);
  expect(rows.map((row) => row.name)).toEqual([
    "20261028000000_start_notify.sql",
    "20261028000100_sync.sql",
    "20261028000200_auth.sql",
    "20261030000000_sync_public.sql",
    "20261031000000_blobs.sql",
    "20261031000200_auth_mcp.sql",
    "20261031000300_auth_signin_client.sql",
  ]);
}, 30_000);
`;

/** A user line that misreads a query's row: tsc must reject it when Reylo's types are in use. */
export const wrongQueryType = `import type { DatabaseSync } from "node:sqlite";

import lastIdQuery from "../tinker/components/database-sqlite/queries/last_id.sql";

declare const db: DatabaseSync;

export const wrong: string = lastIdQuery.runSync(db, { channel: "proof" });
`;
