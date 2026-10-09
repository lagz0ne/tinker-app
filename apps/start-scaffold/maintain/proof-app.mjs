import assert from "node:assert/strict";
import { cp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Copy the app and replace only its native data sources; the installed base stays untouched. */
export async function copyProofApp(source, target) {
  for (const name of [
    "src",
    "tests",
    "drizzle",
    "package.json",
    "vite.config.ts",
    "tsconfig.json",
    "components.json",
  ])
    await cp(join(source, name), join(target, name), { recursive: true });
  await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");
  const databaseFile = join(target, "src/backend/database.server.ts");
  const database = await readFile(databaseFile, "utf8");
  const start = database.indexOf("export const database = resource({");
  const end = database.indexOf("export const migrate = operation({");
  assert.ok(start >= 0 && end > start, "the app declares its database before migrations");
  await writeFile(
    databaseFile,
    database
      .slice(0, start)
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
      return Object.assign(drizzle({ client }), {
        listen: async (wake: () => void) => client.listen("start_sync", wake),
      });
    },
  });\n` +
      database.slice(end),
  );
  const mailFile = join(target, "src/backend/mail.server.ts");
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

/** Local-only settings for the proof data sources and the base's enabled parts. */
export const proofEnv = {
  PUBLIC_ORIGIN: "http://localhost:4318",
  AUTH_SECRET: "local-proof-only-secret-with-thirty-two-letters",
  DATABASE_URL: "postgres://proof",
  SMTP_HOST: "proof",
  SMTP_PORT: "25",
  SMTP_USER: "",
  SMTP_PASSWORD: "",
  SMTP_FROM: "proof@example.com",
  VICTORIA_TRACES_URL: "http://127.0.0.1:1/insert/opentelemetry/v1/traces",
  VICTORIA_LOGS_URL: "http://127.0.0.1:1/insert/jsonline",
};
