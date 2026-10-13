import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
mkdirSync(join(repo, ".bench"), { recursive: true });
const root = mkdtempSync(join(repo, ".bench/join-proof-"));
const vp = join(repo, "node_modules/.bin/vp");
const cli = join(repo, "packages/start/bin/tinker.mjs");

const env = {
  ...process.env,
  DATABASE_URL: "postgres://proof/db",
  SMTP_URL: "smtp://proof:25",
  MAIL_FROM: "proof@example.test",
};

/** Proof commands run in the fixture, with real installed peers. */
function run(command, args, code = 0) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.equal(result.status, code, `${command} ${args.join(" ")}`);
  return `${result.stdout}${result.stderr}`;
}

/** Only the proof's throwaway app is written. */
function write(file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

try {
  cpSync(join(repo, "apps/start-min/src"), join(root, "src"), { recursive: true });
  for (const file of ["package.json", "vite.config.ts", "tsconfig.json", ".gitignore"]) {
    cpSync(join(repo, "apps/start-min", file), join(root, file));
  }
  symlinkSync(join(repo, "apps/start-scaffold/node_modules"), join(root, "node_modules"));
  for (const file of ["database.server.ts", "modules.ts"]) {
    cpSync(join(repo, "apps/start-scaffold/src/backend", file), join(root, "src/backend", file));
  }

  write(
    "src/backend/mail.server.ts",
    `import { tag } from "@tinker/core";
export const smtpUrl = tag<URL>({ label: "mail.smtpUrl" });
export const mailFrom = tag<string>({ label: "mail.from" });
`,
  );
  write(
    "src/items/10-postgres/database.server.ts",
    'export { database as default } from "@/backend/database.server";\n',
  );
  write(
    "src/items/10-postgres/settings.server.ts",
    `import type { Env } from "@tinker/start/server";
import { databaseUrl } from "@/backend/database.server";
export default function settings(env: Env.Values) {
  return [databaseUrl(new URL(env.DATABASE_URL!))];
}
`,
  );
  write(
    "src/items/20-mail/extensions.server.ts",
    `import { extension } from "@tinker/core";
import { mailFrom, smtpUrl } from "@/backend/mail.server";
export default [extension({ label: "mail", hooks: {
  async start({ resolve, next }) {
    resolve(smtpUrl);
    resolve(mailFrom);
    await next();
  },
} })];
`,
  );
  write(
    "src/items/20-mail/settings.server.ts",
    `import type { Env } from "@tinker/start/server";
import { mailFrom, smtpUrl } from "@/backend/mail.server";
export default function settings(env: Env.Values) {
  return [smtpUrl(new URL(env.SMTP_URL!)), mailFrom(env.MAIL_FROM!)];
}
`,
  );
  write(
    "src/backend/greet.ts",
    `import { operation } from "@tinker/core";
import { databaseUrl } from "./database.server";
import { mailFrom, smtpUrl } from "./mail.server";
import { z } from "zod";
export const greet = operation({
  label: "greet",
  input: z.object({ name: z.string() }),
  depends: { databaseUrl, smtpUrl, mailFrom },
  run: ({ databaseUrl, smtpUrl, mailFrom }) => ({ text: [databaseUrl.href, smtpUrl.href, mailFrom].join(" | ") }),
});
`,
  );
  const own = "export const extensions = [];\nexport const settings = () => [];\n";
  write("src/lib/tinker.server.ts", own);
  write("src/lib/tinker.ts", "export const extensions = [];\n");

  run(process.execPath, [cli, "prepare"]);
  run(vp, ["build"]);
  run(process.execPath, [cli, "doctor"]);
  assert.equal(readFileSync(join(root, "src/lib/tinker.server.ts"), "utf8"), own);
  run(process.execPath, [
    "--input-type=module",
    "-e",
    `
const built = await import('./dist/server/server.js');
try {
  const response = await built.default.fetch(new Request('http://proof/'));
  const body = await response.text();
  if (response.status !== 200 || !body.includes('postgres://proof/db | smtp://proof:25 | proof@example.test')) throw new Error(body);
  console.log('PASS three item tags reach Start; mail extension starts');
} finally { await built.close(); }
`,
  ]);

  write("src/items/30-other/database.server.ts", "export default 42;\n");
  const conflict = run(process.execPath, [cli, "prepare"], 1);
  assert.ok(conflict.includes("src/items/30-other/database.server.ts"));
  assert.ok(conflict.includes("src/items/10-postgres/database.server.ts"));
  const doctor = run(process.execPath, [cli, "doctor"], 1).replaceAll(/\s+/g, " ");
  assert.ok(
    doctor.includes(
      "src/items/10-postgres/database.server.ts and src/items/30-other/database.server.ts",
    ),
  );
  console.log("PASS item fixture builds; doctor 0; duplicate owners fail prepare and doctor");
} finally {
  rmSync(root, { recursive: true, force: true });
}
