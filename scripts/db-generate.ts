/**
 * Auto migration for dev (Duke 2026-11-01: generate + apply on dev start).
 * `bun run dev` runs this first. For each drizzle-kit config at the app root
 * (`drizzle.config.ts`, `drizzle.<name>.config.ts`), drizzle-kit writes a new
 * migration file when the schema changed, and nothing when it did not. The
 * facade's start then applies it. The files go in git: prod applies the same.
 * No config: the app has no database, and this does nothing.
 */
const root = process.argv[2] ?? process.cwd();
const configs = [...new Bun.Glob("drizzle{,.*}.config.ts").scanSync(root)].sort();

for (const config of configs) {
  const run = Bun.spawnSync(["bunx", "drizzle-kit", "generate", "--config", config], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (run.exitCode !== 0) {
    console.error(`db:generate: drizzle-kit failed for ${config}`);
    process.exit(run.exitCode ?? 1);
  }
}
