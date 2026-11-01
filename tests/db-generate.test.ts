import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Inside the repo, so the schema file finds drizzle-orm in node_modules.
const folder = mkdtempSync(join(import.meta.dir, ".gen-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const script = join(import.meta.dir, "../scripts/db-generate.ts");

const schema = (
  extra: string,
) => `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),${extra}
});
`;

/** Run the dev step in the folder; return how many migrations exist after it. */
const generate = () => {
  const run = Bun.spawnSync([process.execPath, script, folder], { stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(0);

  return readdirSync(join(folder, "drizzle"), { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  ).length;
};

test("dev start writes a migration only when the schema changed", async () => {
  await Bun.write(join(folder, "schema.ts"), schema(""));
  await Bun.write(
    join(folder, "drizzle.config.ts"),
    `export default { dialect: "sqlite", schema: "./schema.ts", out: "./drizzle" };\n`,
  );

  expect(generate()).toBe(1);
  expect(generate()).toBe(1);

  await Bun.write(
    join(folder, "schema.ts"),
    schema(`\n  done: integer("done").notNull().default(0),`),
  );
  expect(generate()).toBe(2);
}, 60_000);

test("no drizzle config: nothing runs", () => {
  const empty = mkdtempSync(join(import.meta.dir, ".gen-"));
  const run = Bun.spawnSync([process.execPath, script, empty], { stdout: "pipe" });
  rmSync(empty, { recursive: true, force: true });

  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toBe("");
});
