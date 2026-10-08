import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/** Run the app-owned Postgres, Mailpit, better-auth, and two-tab proof; it owns all cleanup. */
const repo = resolve(import.meta.dirname, "../../..");

const proof = spawn(process.execPath, [join(import.meta.dirname, "scaffold-proof.mjs")], {
  cwd: repo,
  env: {
    ...process.env,
    SCAFFOLD_PROOF_LOG:
      process.env.SCAFFOLD_PROOF_LOG ?? join(tmpdir(), "start-scaffold-compose-proof.txt"),
  },
  stdio: "inherit",
});

const code = await new Promise((done, failed) => {
  proof.once("error", failed);
  proof.once("close", done);
});

assert.equal(code, 0, "real auth, SMTP, and two-tab sync proof must pass");
