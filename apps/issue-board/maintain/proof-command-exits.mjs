import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite-plus";

import { proofFault } from "./proof-fault.mjs";

const directory = mkdtempSync(join(tmpdir(), "board-command-controls-"));

const cases = [
  { name: "membership race", command: "cli", kind: "TeamChanged", code: 75 },
  { name: "bad data", command: "cli", kind: "InvalidAssignee", code: 65 },
  { name: "CLI cancel", command: "cli", cancel: true },
  { name: "worker cancel", command: "worker", cancel: true },
];

try {
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
      `import {operation,tag} from "@tinker/core"; export const mailWorkerStop=tag({label:"proof.stop"}); export const ${name}=operation({label:"proof.command",depends:${trial.command === "worker" ? "{stopping:mailWorkerStop}" : "{}"},run:async(deps,{signal,raise,log})=>{const stopping=${trial.command === "worker" ? "deps.stopping" : "signal"};${body}}});`,
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

      const stopping = new AbortController();

      const codes = [];

      let errors = "";

      let output = "";

      const app = await main({
        env: {
          DATABASE_URL: "postgres://proof@localhost/proof",
          SMTP_URL: "smtp://localhost:11026",
          SMTP_FROM: "proof@example.test",
        },
        args:
          trial.command === "worker"
            ? []
            : ["--file", "proof.csv", "--team", "ENG", "--actor", "proof@example.test"],
        signal: stopping.signal,
        stdout: {
          write(text) {
            output += text;

            if (text.includes('"proof.waiting"')) stopping.abort();
          },
        },
        stderr: {
          write(text) {
            errors += text;
          },
        },
        exit(code) {
          codes.push(code);
        },
      });

      await app.closed;

      assert.deepEqual(codes, trial.cancel ? [] : [trial.code], trial.name);

      if (trial.cancel) assert.equal(errors, "", trial.name);

      if (trial.command === "worker") assert(output.includes("outbox worker stopped"));

      console.log("PASS actual command with scratch failure operation: " + trial.name);
    } finally {
      await vite.close();
    }
  }
} finally {
  delete process.env.BOARD_PROOF_FAULT_FILE;

  delete process.env.BOARD_PROOF_FAULT_COPY;

  rmSync(directory, { recursive: true, force: true });
}
