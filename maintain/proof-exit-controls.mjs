import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const source = readFileSync(new URL(import.meta.resolve("@tinker/start/main-host")), "utf8");

const server = readFileSync(new URL("../cmds/server.ts", import.meta.url), "utf8");
const directory = mkdtempSync(join(tmpdir(), "board-exit-controls-"));

const report = "if (code !== 0) report(`command failed (exit ${code})`, savedReason, code);";

const formatter = source.slice(
  source.indexOf("function describeReason("),
  source.indexOf("/** Native startup"),
);

assert(formatter.startsWith("function describeReason("));

const unsafeFormatter = `function describeReason(reason, exitCode) {
  return exitCode !== 1 && reason.kind && reason.payload
    ? reason.kind + ": " + JSON.stringify(reason.payload)
    : reason.stack ?? String(reason);
}

`;

const cases = [
  ...["bigint", "cycle"].map((payload) => ({
    name: "unsafe payload: " + payload,
    from: formatter,
    to: unsafeFormatter,
    body: `error.kind="BadInput";error.payload=${payload === "bigint" ? "{value:1n}" : "{}"};${payload === "cycle" ? "error.payload.self=error.payload;" : ""}exit(65,error);exitReturned=true;`,
    mustReturn: true,
    code: 65,
    prefix: "command failed (exit 65)",
  })),
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
    finishFrom: "    await flushOutput([stdout, stderr])",
    finishTo: "    " + report + "\n\n    await flushOutput([stdout, stderr])",
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

      let copy = broken ? source.replace(trial.from, trial.to) : source;
      if (broken && trial.finishFrom) {
        assert(copy.includes(trial.finishFrom));
        copy = copy.replace(trial.finishFrom, trial.finishTo);
      }
      writeFileSync(path, copy);

      const script = `import assert from "node:assert/strict";import {createMainHost} from ${JSON.stringify(pathToFileURL(path).href)};const error=new Error("exit proof failure");let errors="";let exitReturned=false;const host=createMainHost(async({exit})=>{${trial.body}return{closed:Promise.resolve()};},{env:{},stdout:{write(){}},stderr:{write(text){errors+=text;}}});${trial.pending ? "await host.started;" : `assert.equal(await host.closed,${trial.code});`}${trial.mustReturn ? 'assert.equal(exitReturned,true,"exit must not throw for an unserializable payload");' : ""}assert.equal(errors,${JSON.stringify(trial.prefix)}+": "+error.stack+"\\n","one exit reason stack");`;

      const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: 10000,
      });

      assert.equal(run.status, broken ? 1 : 0, run.stdout + run.stderr);

      if (broken && trial.pending) {
        const finite = script
          .replace("closed:new Promise(()=>{})", "closed:Promise.resolve()")
          .replace("await host.started;", "assert.equal(await host.closed,1);");
        const finished = spawnSync(process.execPath, ["--input-type=module", "-e", finite], {
          encoding: "utf8",
          timeout: 10000,
        });
        assert.equal(
          finished.status,
          0,
          "delayed print must still work after closed: " + finished.stderr,
        );
      }

      if (broken) assert(run.stderr.includes("AssertionError"), run.stderr);
      if (broken && trial.mustReturn) {
        assert(
          run.stderr.includes("exit must not throw for an unserializable payload"),
          run.stderr,
        );
      }
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
