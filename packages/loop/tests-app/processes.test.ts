import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createScope } from "@tinker/core";
import { expect, onTestFinished, test } from "vite-plus/test";

import { processes } from "@/resources/processes";
import { appDir, childEnv } from "@/tags";

import { tempFolder } from "./temp";

const node = process.execPath;

const stubborn = [
  node,
  "-e",
  "process.on('SIGTERM', () => {}); require('fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000)",
];

/** The pid a stubborn child wrote, once it wrote it. */
async function pidIn(dir: string) {
  const file = join(dir, "pid");
  while (!existsSync(file) || readFileSync(file, "utf8") === "") await delay(20);
  return Number(readFileSync(file, "utf8"));
}

/** @param pid - From pidIn; why: true once no process has it. */
function gone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as { code?: string }).code === "ESRCH";
  }
}

test("exit 0 gives null, any other end says how, and the output goes to its file", async () => {
  const dir = tempFolder();
  const scope = createScope({ tags: [appDir(dir), childEnv({})] });
  const { run } = scope.resolve(processes);

  const ok = await run({ command: [node, "-e", "console.log('hi')"], out: join(dir, "ok.log") });
  const bad = await run({ command: [node, "-e", "process.exit(3)"], out: join(dir, "bad.log") });
  const none = await run({ command: ["/no/such/program"], out: join(dir, "none.log") });
  await scope.close();

  expect(ok).toBe(null);
  expect(readFileSync(join(dir, "ok.log"), "utf8")).toBe("hi\n");
  expect(bad).toBe("exited with code 3");
  expect(none).toMatch(/^could not start: /);
});

test("a child sees only the childEnv tag, not the tool's own env, and runs in appDir", async () => {
  const dir = tempFolder();
  process.env.LOOP_TOOL_ONLY = "from the tool";
  onTestFinished(() => {
    delete process.env.LOOP_TOOL_ONLY;
  });
  const scope = createScope({ tags: [appDir(dir), childEnv({ LOOP_FROM_TAG: "from the tag" })] });
  const { run } = scope.resolve(processes);
  const out = join(dir, "env.log");

  await run({
    command: [
      node,
      "-e",
      "console.log(JSON.stringify([process.env.LOOP_FROM_TAG ?? null, process.env.LOOP_TOOL_ONLY ?? null, process.cwd()]))",
    ],
    out,
  });
  await run({ command: "echo $LOOP_FROM_TAG", out: join(dir, "shell.log") });
  await scope.close();

  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["from the tag", null, dir]);
  expect(readFileSync(join(dir, "shell.log"), "utf8")).toBe("from the tag\n");
});

test("a timeout ends the child's whole group, SIGKILL after 5 seconds when it ignores SIGTERM", async () => {
  const dir = tempFolder();
  const scope = createScope({ tags: [appDir(dir), childEnv({})] });
  const { run } = scope.resolve(processes);

  const ending = await run({ command: stubborn, timeout: 300, out: join(dir, "out.log") });
  const pid = await pidIn(dir);
  await scope.close();

  expect(ending).toBe("timed out after 300 ms");
  expect(gone(pid)).toBe(true);
}, 15_000);

test("the caller's stop ends the child's group", async () => {
  const dir = tempFolder();
  const scope = createScope({ tags: [appDir(dir), childEnv({})] });
  const { run } = scope.resolve(processes);
  const stop = new AbortController();

  const ran = run({ command: stubborn, out: join(dir, "out.log") }, stop.signal);
  const pid = await pidIn(dir);
  stop.abort();
  const ending = await ran;
  await scope.close();

  expect(ending).toBe("was stopped");
  expect(gone(pid)).toBe(true);
}, 15_000);

test("closing the root while a child ignores SIGTERM ends its group within 6 seconds", async () => {
  const dir = tempFolder();
  const scope = createScope({ tags: [appDir(dir), childEnv({})] });
  const { run } = scope.resolve(processes);

  const ran = run({ command: stubborn, out: join(dir, "out.log") });
  const pid = await pidIn(dir);
  const started = performance.now();
  const closed = await scope.close();
  const took = performance.now() - started;

  expect(took).toBeLessThan(6000);
  expect(gone(pid)).toBe(true);
  expect(await ran).toBe("was stopped");
  expect(closed.teardownErrors ?? []).toEqual([]);
}, 15_000);
