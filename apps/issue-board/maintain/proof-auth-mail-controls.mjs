import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = "tinker/components/mail/mail.server.ts";

const source = readFileSync(target, "utf8");

const previous = `export const authMail = resource({
  label: "mail.authWork", depends: { send: sendMail },
  factory: ({ send }, { log, defer }) => {
    const running = new Set<Promise<void>>();
    defer(async () => { await Promise.all(running); });
    return { enqueue(input: Mail.Message) {
      const completed = send.settle({ rawInput: input }).then(result => {
        running.delete(completed);
        if (result.status !== "success") log.error("mail.failed", { status: result.status });
      });
      running.add(completed);
    } };
  },
});
/** Missing mail config */`;

const directory = mkdtempSync(join(tmpdir(), "auth-mail-control-"));

try {
  const start = source.indexOf("export const authMail = resource");
  const end = source.indexOf("/** Missing mail config", start);

  const oldStart = previous.indexOf("export const authMail = resource");
  const oldEnd = previous.indexOf("/** Missing mail config", oldStart);

  assert(start >= 0 && end > start && oldStart >= 0 && oldEnd > oldStart);

  const copy = join(directory, "mail.server.ts");

  writeFileSync(
    copy,
    source.slice(0, start) + previous.slice(oldStart, oldEnd) + source.slice(end),
  );

  const bad = spawnSync(process.execPath, ["maintain/proof-auth-mail.mjs"], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, BOARD_PROOF_FAULT_FILE: target, BOARD_PROOF_FAULT_COPY: copy },
  });

  assert.equal(bad.error, undefined, bad.stdout + bad.stderr);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /auth enqueue must survive server death before SMTP/);

  console.log(
    "PASS durable auth mail control: former in-memory sender loses mail after server death at the durable-row assertion.",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
