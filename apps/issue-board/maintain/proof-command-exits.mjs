import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMainHost } from "@tinker/start/main-host";
import pg from "pg";
import { createServer } from "vite-plus";

import { proofFault } from "./proof-fault.mjs";

const directory = mkdtempSync(join(tmpdir(), "board-command-controls-"));

const url = new URL(
  process.env.BOARD_DATABASE_URL ?? "postgres://issue_board@127.0.0.1:15433/postgres",
);

const admin = new pg.Client({ connectionString: url.href });
const database = "command_exits_" + randomUUID().replaceAll("-", "");

const cases = [
  { name: "membership race", command: "cli", kind: "TeamChanged", code: 75 },
  { name: "bad data", command: "cli", kind: "InvalidAssignee", code: 65 },
  { name: "CLI cancel", command: "cli", cancel: true },
  { name: "worker cancel", command: "worker", cancel: true },
];

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  url.pathname = "/" + database;
  for (const trial of cases) {
    const target =
      trial.command === "worker"
        ? "src/backend/outbox.server.ts"
        : "src/transport/import-runner.server.ts";

    const copy = join(directory, "operation.ts");

    const name = trial.command === "worker" ? "runMailWorker" : "runImport";

    const body = trial.cancel
      ? `const pending=new Promise((_resolve,reject)=>stopping.addEventListener("abort",()=>reject(stopping.reason),{once:true})); log("proof.waiting"); await pending;`
      : `raise(${JSON.stringify(trial.kind)},{});`;

    writeFileSync(
      copy,
      `import {operation} from "@tinker/core"; import {mailWorkerStop} from "~/components/mail/index.server"; export const ${name}=operation({label:"proof.command",depends:${trial.command === "worker" ? "{stopping:mailWorkerStop}" : "{}"},run:async(deps,{signal,raise,log})=>{const stopping=${trial.command === "worker" ? "deps.stopping" : "signal"};${body}}});`,
    );

    process.env.BOARD_PROOF_FAULT_FILE = target;

    process.env.BOARD_PROOF_FAULT_COPY = copy;

    const vite = await createServer({
      configFile: false,
      plugins: [proofFault()],
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, hmr: false },
      resolve: {
        alias: {
          "@": fileURLToPath(new URL("../src", import.meta.url)),
          "~": fileURLToPath(new URL("../tinker", import.meta.url)),
        },
      },
    });

    try {
      const { default: main } = await vite.ssrLoadModule(`/cmds/${trial.command}.ts`);

      let errors = "";

      let output = "";

      const host = createMainHost(main, {
        env: {
          DATABASE_URL: url.href,
          SMTP_URL: "smtp://localhost:11026",
          SMTP_FROM: "proof@example.test",
        },
        args:
          trial.command === "worker"
            ? []
            : ["--file", "proof.csv", "--team", "ENG", "--actor", "proof@example.test"],
        stdout: {
          write(text) {
            output += text;

            if (text.includes('"proof.waiting"')) {
              host.stop(130, new DOMException("SIGINT", "AbortError"));
            }
          },
        },
        stderr: {
          write(text) {
            errors += text;
          },
        },
      });

      const code = await host.closed;

      assert.equal(code, trial.cancel ? 130 : trial.code, trial.name);

      if (trial.cancel) {
        assert.equal(errors, "", trial.name);
      } else {
        assert(errors.startsWith(`command failed (exit ${trial.code}): ${trial.kind}: `), errors);
      }

      if (trial.command === "worker") assert(output.includes("outbox worker stopped"));

      console.log("PASS actual command with scratch failure operation: " + trial.name);
    } finally {
      await vite.close();
    }
  }
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
  delete process.env.BOARD_PROOF_FAULT_FILE;

  delete process.env.BOARD_PROOF_FAULT_COPY;

  rmSync(directory, { recursive: true, force: true });
}
