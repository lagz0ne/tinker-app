import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { main } from "../lib/main.mjs";
import {
  commit,
  fail,
  findingsOf,
  git,
  loop,
  loopJson,
  pass,
  repo,
  setFindings,
} from "./fixture.mjs";

const okGate = `node -e "process.exit(require('fs').existsSync('ok') ? 0 : 1)"`;

test("a red gate is one important G1 finding; later gates still run; the exit is 1", async () => {
  const app = repo({
    "loop.json": loopJson({
      first: `node -e "console.log('building'); console.error('Error: boom 12ms'); process.exit(2)"`,
      second: `node -e "require('fs').writeFileSync('second-ran', '')"`,
      third: fail,
    }),
  });

  const run = await loop(app, "check");

  expect(run.code).toBe(1);
  expect(existsSync(join(app, "second-ran"))).toBe(true);
  expect(run.stdout).toContain("FAIL first\nPASS second\nFAIL third\n");
  expect(run.stdout).toContain("round 1: 1 gates green, 2 red");
  expect(findingsOf(app)).toEqual([
    expect.objectContaining({
      rule: "G1",
      severity: "important",
      file: "first",
      line: null,
      summary: "Error: boom 12ms",
      source: "check",
      round: 1,
      status: "open",
    }),
    expect.objectContaining({ rule: "G1", file: "third", summary: "exited with code 1" }),
  ]);
  expect(findingsOf(app)[0].trigger).toContain("exited with code 2");
  expect(readFileSync(join(app, ".loop/gates/first.log"), "utf8")).toContain("building");
});

test("green gates exit 0 and add no finding", async () => {
  const app = repo({ "loop.json": loopJson({ one: pass, two: pass }) });

  const run = await loop(app, "check");

  expect(run.code).toBe(0);
  expect(run.stdout).toContain("2 gates green, 0 red");
  expect(readFileSync(join(app, ".loop/findings.jsonl"), "utf8")).toBe("");
});

test("git never sees the .loop folder, even when the app does not ignore it", async () => {
  const app = repo({ "loop.json": loopJson({ red: fail }) });

  await loop(app, "check");

  expect(git(app, "status", "--porcelain", "--untracked-files=all")).toBe("");
});

test("the summary prints counts and each open important finding on one line", async () => {
  const app = repo({ "loop.json": loopJson({ types: fail }) });

  const { stdout } = await loop(app, "check");
  const [finding] = findingsOf(app);

  expect(stdout).toContain("severity: important 1, question 0, nit 0, old 0\n");
  expect(stdout).toContain("status: open 1, answered 0, fixed 0\n");
  expect(stdout).toContain(`open important:\n  G1 types: exited with code 1 [${finding.id}]\n`);
});

test("a re-run keeps the id and updates the finding instead of adding one", async () => {
  const app = repo({
    "loop.json": loopJson({
      slow: `node -e "console.error('FAIL took ' + process.pid + 'ms'); process.exit(1)"`,
    }),
  });

  await loop(app, "check");
  const [first] = findingsOf(app);
  await loop(app, "check");
  const all = findingsOf(app);

  expect(all).toHaveLength(1);
  expect(all[0].id).toBe(first.id);
  expect(all[0].round).toBe(2);
  expect(all[0].status).toBe("open");
});

test("a gone check finding is fixed at HEAD, and opens again when it comes back", async () => {
  const app = repo({ "loop.json": loopJson({ ok: okGate }) });
  await loop(app, "check");

  const sha = commit(app, { ok: "" }, "fix");
  const green = await loop(app, "check");
  const [fixed] = findingsOf(app);

  expect(green.code).toBe(0);
  expect(fixed).toEqual(expect.objectContaining({ status: "fixed", sha, round: 2 }));

  git(app, "rm", "--quiet", "ok");
  commit(app, {}, "break");
  await loop(app, "check");
  const [again] = findingsOf(app);

  expect(again.id).toBe(fixed.id);
  expect(again.status).toBe("open");
  expect(again).not.toHaveProperty("sha");
});

test("an answered finding keeps its reason when seen again, and is fixed when gone", async () => {
  const app = repo({ "loop.json": loopJson({ ok: okGate }) });
  await loop(app, "check");
  setFindings(app, [{ ...findingsOf(app)[0], status: "answered", reason: "known flake" }]);

  await loop(app, "check");
  const [seen] = findingsOf(app);
  const sha = commit(app, { ok: "" }, "fix");
  await loop(app, "check");
  const [gone] = findingsOf(app);

  expect(seen).toEqual(
    expect.objectContaining({ status: "answered", reason: "known flake", round: 2 }),
  );
  expect(gone).toEqual(expect.objectContaining({ status: "fixed", sha, reason: "known flake" }));
});

test("judge and review findings stay as they are", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }) });
  await loop(app, "check");
  const review = {
    id: "review-1",
    rule: "C3",
    severity: "important",
    file: "src/x.ts",
    line: 4,
    summary: "a write opens its own session",
    trigger: "the save path",
    fix: "use the session transaction",
    source: "review",
    round: 1,
    status: "open",
  };
  setFindings(app, [review]);

  await loop(app, "check");

  expect(findingsOf(app)).toEqual([review]);
});

test("the scan reads only added lines since base and never changes the exit code", async () => {
  const app = repo({
    "loop.json": loopJson({ ok: pass }, "main"),
    "src/old.ts": "Math.random();\n",
  });
  git(app, "checkout", "--quiet", "-b", "work");
  commit(
    app,
    {
      "src/old.ts": "",
      "src/a.ts":
        "const one = 1;\nconst t = Date.now();\nconst k = process.env.KEY;\nclass Store {}\n",
    },
    "change",
  );

  const run = await loop(app, "check");
  const hits = findingsOf(app).map(({ rule, file, line, severity }) => [
    rule,
    file,
    line,
    severity,
  ]);

  expect(run.code).toBe(0);
  expect(hits).toEqual([
    ["B3", "src/a.ts", 2, "question"],
    ["B1", "src/a.ts", 3, "question"],
    ["O1", "src/a.ts", 4, "question"],
  ]);
  expect(findingsOf(app)[0].summary).toBe("clock or random: const t = Date.now();");
});

test("each quick-scan grep gives its rule", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }, "main") });
  git(app, "checkout", "--quiet", "-b", "work");
  const lines = {
    "process.argv": "B1",
    "process.exit(1)": "B1",
    "Math.random()": "B3",
    "crypto.randomUUID()": "B3",
    "setInterval(tick, 5)": "O1",
    'await fetch("/x")': "H3",
    'import "node:http"': "H3",
    'import "node:net"': "H3",
    'test.skip("x")': "H5",
    "input as unknown as Item": "H2",
  };
  commit(app, { "src/b.ts": `${Object.keys(lines).join("\n")}\n` }, "change");

  await loop(app, "check");

  expect(findingsOf(app).map((finding) => finding.rule)).toEqual(Object.values(lines));
});

test("a scan hit keeps its id when its line moves, and is fixed when removed", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }, "main") });
  git(app, "checkout", "--quiet", "-b", "work");
  commit(app, { "src/a.ts": "Date.now();\n" }, "add");
  await loop(app, "check");
  const [first] = findingsOf(app);

  commit(app, { "src/a.ts": "\n\nDate.now();\n" }, "move");
  await loop(app, "check");
  const moved = findingsOf(app);
  const sha = commit(app, { "src/a.ts": "\n" }, "remove");
  await loop(app, "check");

  expect(moved).toEqual([expect.objectContaining({ id: first.id, line: 3, round: 2 })]);
  expect(findingsOf(app)).toEqual([
    expect.objectContaining({ id: first.id, status: "fixed", sha }),
  ]);
});

test("the scan covers only the app folder and names files from it", async () => {
  const root = repo({ "apps/one/loop.json": loopJson({ ok: pass }, "main") });
  git(root, "checkout", "--quiet", "-b", "work");
  commit(root, { "apps/one/src/a.ts": "Date.now();\n", "other/b.ts": "Date.now();\n" }, "change");

  await loop(root, "check", "--app", "apps/one");

  expect(findingsOf(join(root, "apps/one")).map((finding) => finding.file)).toEqual(["src/a.ts"]);
});

test("--base wins over loop.json; a base git cannot find skips the scan", async () => {
  const app = repo({ "loop.json": loopJson({ ok: pass }, "missing") });
  const base = git(app, "rev-parse", "HEAD");
  commit(app, { "a.ts": "Date.now();\n" }, "change");

  const skipped = await loop(app, "check");
  const scanned = await loop(app, "check", "--base", base);

  expect(skipped.code).toBe(0);
  expect(skipped.stdout).toContain("scan skipped: no base found; pass --base <ref>");
  expect(scanned.stdout).not.toContain("scan skipped");
  expect(findingsOf(app).map((finding) => finding.rule)).toEqual(["B3"]);
});

test("a red gate keeps one id when its message changes", async () => {
  const app = repo({
    "loop.json": loopJson({
      types: `node -e "console.error('error: ' + require('fs').readFileSync('message', 'utf8')); process.exit(1)"`,
    }),
    message: "first",
  });
  await loop(app, "check");
  const [first] = findingsOf(app);

  commit(app, { message: "second" }, "new message");
  await loop(app, "check");

  expect(findingsOf(app)).toEqual([
    expect.objectContaining({ id: first.id, summary: "error: second", status: "open" }),
  ]);
});

test("a skipped scan leaves scan findings as they are; gate findings still change", async () => {
  const app = repo({ "loop.json": loopJson({ ok: okGate }, "main") });
  git(app, "checkout", "--quiet", "-b", "work");
  commit(app, { "src/a.ts": "Date.now();\n" }, "change");
  await loop(app, "check");

  const sha = commit(app, { ok: "" }, "fix the gate");
  const run = await loop(app, "check", "--base", "missing");
  const rows = Object.fromEntries(findingsOf(app).map((row) => [row.rule, row]));

  expect(run.stdout).toContain("scan skipped: git cannot find --base missing");
  expect(rows.B3).toEqual(expect.objectContaining({ status: "open", round: 1 }));
  expect(rows.G1).toEqual(expect.objectContaining({ status: "fixed", sha }));
});

test("rows another tool writes while the gates run are kept", async () => {
  const review = { id: "review-1", rule: "C3", source: "review", round: 1, status: "open" };
  const append = `node -e "require('fs').appendFileSync('.loop/findings.jsonl', process.argv[1] + '\\n')" '${JSON.stringify(review)}'`;
  const app = repo({ "loop.json": loopJson({ write: append, red: fail }) });

  await loop(app, "check");

  expect(findingsOf(app)).toEqual([
    review,
    expect.objectContaining({ rule: "G1", file: "red", round: 2 }),
  ]);
});

test("a check after a review at round 5 is round 6", async () => {
  const app = repo({ "loop.json": loopJson({ red: fail }) });
  await loop(app, "check");
  setFindings(app, [{ id: "review-1", rule: "C3", source: "review", round: 5, status: "open" }]);

  const { stdout } = await loop(app, "check");

  expect(stdout).toContain("tinker-loop check, round 6:");
  expect(findingsOf(app)[1]).toEqual(expect.objectContaining({ rule: "G1", round: 6 }));
});

test("a gate past its timeout is red, and its whole process group is killed", async () => {
  const sleeper = `node -e "const c = require('child_process').spawn('sleep', ['30'], { stdio: 'ignore' }); require('fs').writeFileSync('pid', String(c.pid)); setTimeout(() => {}, 30000)"`;
  const app = repo({
    "loop.json": JSON.stringify({ gates: [{ name: "slow", run: sleeper, timeout: 1000 }] }),
  });

  const run = await loop(app, "check");
  const pid = Number(readFileSync(join(app, "pid"), "utf8"));

  expect(run.code).toBe(1);
  expect(findingsOf(app)[0].summary).toBe("timed out after 1000 ms");
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
});

test("a stop kills the running gate, writes nothing, and exits 130", async () => {
  const app = repo({ "loop.json": loopJson({ slow: 'node -e "setTimeout(() => {}, 30000)"' }) });
  const stop = new AbortController();
  setTimeout(() => stop.abort("SIGINT"), 300);

  const code = await main({
    args: ["check"],
    cwd: app,
    stdout: { write: () => true },
    stderr: { write: () => true },
    signal: stop.signal,
  });

  expect(code).toBe(130);
  expect(existsSync(join(app, ".loop/findings.jsonl"))).toBe(false);
});

test("a missing or bad loop.json exits 78; an unknown command or flag exits 64", async () => {
  const app = repo({ "readme.md": "" });

  const missing = await loop(app, "check");
  commit(
    app,
    { "loop.json": '{"gates":[{"name":"a","run":"x"},{"name":"a","run":"y"}]}' },
    "twice",
  );
  const twice = await loop(app, "check");
  commit(
    app,
    { "loop.json": '{"gates":[{"name":"a/b","run":"x"},{"name":"a-b","run":"y"}]}' },
    "logs",
  );
  const logs = await loop(app, "check");
  commit(app, { "loop.json": '{"gates":[{"name":"a","run":"x","timeout":1.5}]}' }, "timeout");
  const timeout = await loop(app, "check");
  const unknown = await loop(app, "bogus");
  const flag = await loop(app, "check", "--nope");

  expect(missing.code).toBe(78);
  expect(missing.stderr).toContain("loop.json is missing");
  expect(twice.code).toBe(78);
  expect(twice.stderr).toContain("loop.json: gate names must differ");
  expect(logs.code).toBe(78);
  expect(logs.stderr).toContain("since each names a log file");
  expect(timeout.code).toBe(78);
  expect(timeout.stderr).toContain('gate a: "timeout" must be a positive whole number');
  expect(unknown.code).toBe(64);
  expect(flag.code).toBe(64);
});

test("the bin runs check and sets the exit code", () => {
  const app = repo({ "loop.json": loopJson({ red: fail }) });
  const bin = fileURLToPath(new URL("../bin/tinker-loop.mjs", import.meta.url));

  const run = spawnSync(process.execPath, [bin, "check"], { cwd: app, encoding: "utf8" });

  expect(run.status).toBe(1);
  expect(run.stdout).toContain("FAIL red");
});
