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

test("cn and defineMain pass by name, and defineMain takes the command's main", async () => {
  const result = await checkFiles({
    "src/frontend/ui/classes.ts": `export function cn(...names: string[]) {\n  return names.join(" ");\n}\n`,
    "tinker/base/main.ts": `export const defineMain = <R>(main: () => Promise<R>) => main;\n`,
    "cmds/server.ts": `import { defineMain } from "~/base/main";\n\nexport default defineMain(async () => ({ closed: Promise.resolve() }));\n`,
  });

  expect(result).toMatchObject({ code: 0, err: "" });
});

test("defineMain outside tinker/base/main.ts fails", async () => {
  const result = await checkFiles({
    "src/main.ts": `export const defineMain = <R>(main: () => Promise<R>) => main;\n`,
  });

  expect(result.code).toBe(1);
  expect(result.err.trim()).toBe(hit("src/main.ts", 1));
});

test("a function frozen or put in an array at the top level fails", async () => {
  const result = await checkFiles({
    "src/a.ts": "export const shout = Object.freeze((s: string) => `${s}!`);\n",
    "src/b.ts": `export const [whisper] = [(s: string) => s.toLowerCase()];\n`,
    "src/c.ts": `export const names = Object.entries({ a: 1 }).map(([name]) => name);\n`,
  });

  expect(result.code).toBe(1);
  expect(result.err).toContain(hit("src/a.ts", 1));
  expect(result.err).toContain(hit("src/b.ts", 1));
  expect(result.err).toContain(hit("src/c.ts", 1));
});

test("a callback of a library value passes, here or through an app import", async () => {
  const result = await checkFiles({
    "tinker/schema.ts": `import { z } from "zod";\n\nexport const batch = z.object({ n: z.number() });\n`,
    "tinker/strict.ts": `import { batch } from "./schema";\n\nexport const small = batch.refine((b) => b.n < 9);\n`,
    "cmds/host.ts": `export const names = [...new Bun.Glob("*").scanSync(".")].filter((n) => n !== "x");\n`,
  });

  expect(result).toMatchObject({ code: 0, err: "" });
});

test("a helper in an .mts or .cts file fails; a .d.mts file is skipped", async () => {
  const result = await checkFiles({
    "src/util.mts": `export const loud = (s: string) => s.toUpperCase();\n`,
    "tinker/util.cts": `export function quiet(s: string) {\n  return s;\n}\n`,
    "src/types.d.mts": `export function typed(s: string) {\n  return s;\n}\n`,
  });

  expect(result.code).toBe(1);
  expect(result.err).toContain(hit("src/util.mts", 1));
  expect(result.err).toContain(hit("tinker/util.cts", 1));
  expect(result.err).not.toContain("types.d.mts");
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
