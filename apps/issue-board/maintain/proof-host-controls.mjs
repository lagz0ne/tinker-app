import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const source = readFileSync("../../packages/start/lib/main-host.mjs", "utf8");
const directory = mkdtempSync(join(tmpdir(), "board-host-controls-"));

const cases = [
  {
    name: "grace-delay",
    from: "setTimeout(() => hardStop(), graceMs)",
    to: "setTimeout(() => hardStop(), 0)",
    check: `const pending = Promise.withResolvers(); let stops = 0; const host = createMainHost(async ({exit}) => { exit(0); return {closed:pending.promise}; }, {...options,graceMs:100,hardStop:()=>{stops++;}}); await host.started; await new Promise(done=>setTimeout(done,20)); assert.equal(stops,0,"grace must wait for its deadline"); pending.resolve(); await host.closed;`,
  },
  {
    name: "grace-cleared",
    from: "clearTimeout(timer);",
    to: "void timer;",
    check: `let stops=0; const host=createMainHost(async ({exit})=>{exit(0);return {closed:Promise.resolve()};},{...options,graceMs:10,hardStop:()=>{stops++;}}); await host.closed; await new Promise(done=>setTimeout(done,30)); assert.equal(stops,0,"clean close must cancel grace");`,
  },
  {
    name: "first-reason",
    from: "controller.abort(reason);",
    to: 'controller.abort("wrong reason");',
    check: `const host=createMainHost(async({exit})=>{exit(65,"first");exit(78,"second");return {closed:Promise.resolve()};},options); assert.equal(await host.closed,65); assert.equal(host.signal.reason,"first","reason check must run outside main");`,
  },
];

try {
  for (const trial of cases) {
    assert(source.includes(trial.from), trial.name);

    const good = join(directory, "good.mjs");

    const broken = join(directory, trial.name + ".mjs");

    writeFileSync(good, source);

    writeFileSync(broken, source.replace(trial.from, trial.to));

    for (const [path, status] of [
      [good, 0],
      [broken, 1],
    ]) {
      const script = `import assert from "node:assert/strict"; import {createMainHost} from ${JSON.stringify(pathToFileURL(path).href)}; const quiet={write(){}};const options={env:{},stdout:quiet,stderr:quiet}; ${trial.check}`;

      const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: 5000,
      });

      assert.equal(run.status, status, run.stdout + run.stderr);

      if (status) assert(run.stderr.includes("AssertionError"), run.stderr);
    }
    console.log("PASS good host and broken scratch control: " + trial.name);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
