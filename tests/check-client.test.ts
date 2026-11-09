import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "vite-plus/test";

const script = join(import.meta.dirname, "../scripts/check-client.ts");
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

test("a compiled server's metafile: only the page's modules count", async () => {
  const folder = mkdtempSync(join(tmpdir(), "check-client-"));
  folders.push(folder);
  const metafile = join(folder, "meta.json");
  const page = { "cmds/browser.tsx": {} };
  const write = (pageInputs: Record<string, unknown>) =>
    Bun.write(
      metafile,
      JSON.stringify({
        inputs: { "cmds/browser.tsx": {}, "cmds/server.ts": {}, "src/backend/greet.ts": {} },
        outputs: {
          "./server": { entryPoint: "cmds/host.ts", inputs: { "cmds/server.ts": {} } },
          "./chunk-a.js": { entryPoint: "cmds/index.html", inputs: pageInputs },
        },
      }),
    );
  const run = () => Bun.spawnSync([process.execPath, script, metafile]);

  await write(page);
  expect(run().stdout.toString()).toBe(
    "client build clean: 1 modules, none from the server side\n",
  );

  await write({ ...page, "src/backend/greet.ts": {} });
  const leaked = run();
  expect(leaked.exitCode).toBe(1);
  expect(leaked.stderr.toString().trim()).toBe("server code in client: src/backend/greet.ts");
});
