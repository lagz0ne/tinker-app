import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../scripts/check-plain.ts");
const folders: string[] = [];

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** Run the check on a fresh app folder that holds only these files. */
async function checkFiles(files: Record<string, string>) {
  const folder = mkdtempSync(join(tmpdir(), "check-plain-"));
  folders.push(folder);
  for (const [path, text] of Object.entries(files)) await Bun.write(join(folder, path), text);

  const run = Bun.spawnSync([process.execPath, script, folder]);
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

const hit = (path: string, line: number) => `${path}:${line}: plain-function: make it an operation`;

test("a plain helper fails", async () => {
  const result = await checkFiles({
    "src/api/greet.ts": `export function shout(s: string) {\n  return s + "!";\n}\n`,
    "tinker/util.ts": `export const twice = (n: number) => n * 2;\n`,
  });

  expect(result.code).toBe(1);
  expect(result.err).toContain(hit("src/api/greet.ts", 1));
  expect(result.err).toContain(hit("tinker/util.ts", 1));
});

test("an IIFE and an object of helpers fail", async () => {
  const result = await checkFiles({
    "src/a.ts": `export const value = (() => 1)();\n`,
    "src/b.ts": `export const util = Object.freeze({\n  shout(s: string) {\n    return s;\n  },\n});\n`,
  });

  expect(result.code).toBe(1);
  expect(result.err).toContain(hit("src/a.ts", 1));
  expect(result.err).toContain(hit("src/b.ts", 2));
});

test("an operation passes, with its inline callbacks", async () => {
  const result = await checkFiles({
    "src/api/greet.ts": `import { operation } from "@tinker/core";

export const shout = operation({
  label: "shout",
  input: (raw: unknown) => String(raw),
  run: (_deps, { input }) => [input].map((s) => s + "!").join(""),
});
`,
  });

  expect(result).toEqual({ code: 0, out: "plain functions: none in 1 files\n", err: "" });
});

test("a resource's returned methods pass; a helper only called inside it fails", async () => {
  const result = await checkFiles({
    "tinker/counter.ts": `import { resource } from "@tinker/core";

export const counter = resource({
  label: "counter",
  factory: (_deps, ctx) => {
    let count = 0;
    const reset = () => (count = 0);
    ctx.defer(reset);
    const double = (n: number) => n * 2;
    const owned = { add: () => double(++count), read: () => count };
    return owned;
  },
});
`,
  });

  expect(result.code).toBe(1);
  expect(result.err.trim()).toBe(hit("tinker/counter.ts", 9));
});

test("capsule hooks pass; a non-hook in hooks fails", async () => {
  const result = await checkFiles({
    "tinker/c.ts": `import { capsule } from "@tinker/core";
import type { Capsule } from "@tinker/core";

export const shared: Capsule.Hooks = {
  async close({ next }) {
    return next();
  },
};

export const c = capsule({
  label: "c",
  hooks: {
    run({ next }) {
      return next();
    },
    helper() {
      return 1;
    },
  },
});
`,
  });

  expect(result.code).toBe(1);
  expect(result.err.trim()).toBe(hit("tinker/c.ts", 16));
});

test("a function returned from a start hook passes", async () => {
  const result = await checkFiles({
    "tinker/rpc.ts": `import { capsule } from "@tinker/core";

export const rpc = capsule({
  label: "rpc",
  hooks: {
    start({ next }) {
      return next().then(() => fetch);

      async function fetch(request: Request) {
        return new Response(request.url);
      }
    },
  },
});
`,
    "tinker/routes.ts": `import { capsule } from "@tinker/core";

export const routes = capsule({
  label: "routes",
  hooks: {
    async start() {
      return async function fetch(request: Request) {
        return Response.json({ url: request.url });
      };
    },
  },
});
`,
  });

  expect(result).toMatchObject({ code: 0, err: "" });
});

test("cn and defineMain pass by name", async () => {
  const result = await checkFiles({
    "src/frontend/ui/classes.ts": `export function cn(...names: string[]) {\n  return names.join(" ");\n}\n`,
    "tinker/base/main.ts": `export const defineMain = <R>(main: () => Promise<R>) => main;\n`,
  });

  expect(result).toMatchObject({ code: 0, err: "" });
});

test("Bun.serve's fetch and error pass", async () => {
  const result = await checkFiles({
    "cmds/host.ts": `Bun.serve({
  fetch(request) {
    return new Response(request.url);
  },
  error: () => new Response(null, { status: 500 }),
  routes: { "/api/*": async () => new Response("ok") },
});
`,
  });

  expect(result).toMatchObject({ code: 0, err: "" });
});

test("a React component and a top-level listener pass", async () => {
  const result = await checkFiles({
    "src/page.tsx": `export function Greeting({ name }: { name: string }) {\n  return <p>{name}</p>;\n}\n`,
    "cmds/browser.ts": `const close = () => console.log("closed");\nwindow.addEventListener("pagehide", close);\n`,
  });

  expect(result).toMatchObject({ code: 0, err: "" });
});
