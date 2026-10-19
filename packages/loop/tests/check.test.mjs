import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, onTestFinished, test } from "vite-plus/test";

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

test("an answered finding keeps its reason when seen again and when gone", async () => {
  const app = repo({ "loop.json": loopJson({ ok: okGate }) });
  await loop(app, "check");
  setFindings(app, [{ ...findingsOf(app)[0], status: "answered", reason: "known flake" }]);

  await loop(app, "check");
  const [seen] = findingsOf(app);
  commit(app, { ok: "" }, "fix");
  await loop(app, "check");
  const [gone] = findingsOf(app);

  expect(seen).toEqual(
    expect.objectContaining({ status: "answered", reason: "known flake", round: 2 }),
  );
  expect(gone).toEqual(expect.objectContaining({ status: "answered", reason: "known flake" }));
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
  expect(skipped.stdout).toContain("scan skipped: no git diff from missing");
  expect(scanned.stdout).not.toContain("scan skipped");
  expect(findingsOf(app).map((finding) => finding.rule)).toEqual(["B3"]);
});

test("a loop.json base that tracks a remote scans from the remote, not the old local copy", async () => {
  const upstream = repo({ "loop.json": loopJson({ ok: pass }, "main") });
  const app = realpathSync(mkdtempSync(join(tmpdir(), "tinker-loop-clone-")));
  onTestFinished(() => rmSync(app, { recursive: true, force: true }));
  git(app, "clone", "--quiet", upstream, ".");
  commit(upstream, { "src/theirs.ts": "Date.now();\n" }, "theirs");
  git(app, "fetch", "--quiet");
  git(app, "checkout", "--quiet", "-b", "work", "origin/main");
  commit(app, { "src/mine.ts": "Math.random();\n" }, "mine");

  const run = await loop(app, "check");

  expect(run.stdout).toContain("scan base: origin/main\n");
  expect(findingsOf(app).map((finding) => finding.file)).toEqual(["src/mine.ts"]);
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
  const unknown = await loop(app, "bogus");
  const flag = await loop(app, "check", "--nope");

  expect(missing.code).toBe(78);
  expect(missing.stderr).toContain("loop.json is missing");
  expect(twice.code).toBe(78);
  expect(twice.stderr).toContain("loop.json: gate names must differ");
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
