import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const source = readFileSync(
  new URL("../../../packages/start/lib/main-host.mjs", import.meta.url),
  "utf8",
);

const server = readFileSync(new URL("../cmds/server.ts", import.meta.url), "utf8");
const directory = mkdtempSync(join(tmpdir(), "board-exit-controls-"));

const report = "if (code !== 0) report(`command failed (exit ${code})`, savedReason, code);";

const cases = [
  {
    name: "first reason lost",
    from: report,
    to: "void savedReason;",
    body: "exit(1,error);",
    code: 1,
    prefix: "command failed (exit 1)",
  },
  {
    name: "hung cleanup loses reason",
    from: report,
    to: "void savedReason;",
    body: "exit(1,error);return {closed:new Promise(()=>{})};",
    pending: true,
    code: 1,
    prefix: "command failed (exit 1)",
  },
  {
    name: "late reason lost",
    from: "if (reason !== savedReason) report(`after exit ${code ?? 0}`, reason, next);",
    to: "void reason;",
    body: "exit(143);exit(1,error);",
    code: 143,
    prefix: "after exit 143",
  },
  {
    name: "saved throw printed twice",
    from: "return failedMain(error, app, signal, stop);",
    to: 'if(error === signal.reason) options.stderr.write(error.stack + "\\n"); return failedMain(error, app, signal, stop);',
    body: "exit(1,error);throw error;",
    code: 1,
    prefix: "command failed (exit 1)",
  },
];

try {
  for (const trial of cases) {
    assert(source.includes(trial.from), trial.name);

    for (const broken of [false, true]) {
      const path = join(directory, "host.mjs");

      writeFileSync(path, broken ? source.replace(trial.from, trial.to) : source);

      const script = `import assert from "node:assert/strict";import {createMainHost} from ${JSON.stringify(pathToFileURL(path).href)};const error=new Error("exit proof failure");let errors="";const host=createMainHost(async({exit})=>{${trial.body}return{closed:Promise.resolve()};},{env:{},stdout:{write(){}},stderr:{write(text){errors+=text;}}});${trial.pending ? "await host.started;" : `assert.equal(await host.closed,${trial.code});`}assert.equal(errors,${JSON.stringify(trial.prefix)}+": "+error.stack+"\\n","one exit reason stack");`;

      const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: 10000,
      });

      assert.equal(run.status, broken ? 1 : 0, run.stdout + run.stderr);

      if (broken) assert(run.stderr.includes("AssertionError"), run.stderr);
    }

    console.log("PASS good host and broken exit control: " + trial.name);
  }

  assert(server.includes("exit(1, error);"));

  const copy = join(directory, "server.ts");

  writeFileSync(copy, server.replace("exit(1, error);", "void error;"));

  const run = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("proof-server-close.mjs", import.meta.url))],
    {
      env: { ...process.env, BOARD_EXIT_SERVER_COPY: copy },
      encoding: "utf8",
      timeout: 30000,
    },
  );

  assert.equal(run.status, 1, run.stdout + run.stderr);

  assert(run.stderr.includes("served server close failure must exit 1"), run.stderr);

  console.log("PASS broken served-server close control: missing exit fails.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
