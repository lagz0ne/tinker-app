import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../scripts/check-client.ts");
const folders: string[] = [];

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** Run the check on a hand-written client metafile that lists these modules, with no imports. */
async function checkInputs(paths: string[]) {
  const folder = mkdtempSync(join(tmpdir(), "check-client-"));
  folders.push(folder);
  const metafile = join(folder, "client-meta.json");
  await Bun.write(
    metafile,
    JSON.stringify({ inputs: Object.fromEntries(paths.map((p) => [p, {}])) }),
  );

  const run = Bun.spawnSync([process.execPath, script, metafile]);
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

test("a client build that holds tinker/base/main-host.ts fails", async () => {
  const result = await checkInputs(["cmds/browser.tsx", "tinker/base/main-host.ts"]);

  expect(result.code).toBe(1);
  expect(result.err.trim()).toBe("server code in client: tinker/base/main-host.ts");
});

test("a client build of client modules passes", async () => {
  const result = await checkInputs(["cmds/browser.tsx", "tinker/base/main.ts"]);

  expect(result).toEqual({
    code: 0,
    out: "client build clean: 2 modules, none from the server side\n",
    err: "",
  });
});
