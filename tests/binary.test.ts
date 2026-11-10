import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ws } from "@tinker/bun/client";
import { createScope } from "@tinker/core";
import type { Subprocess } from "bun";
import { afterAll, afterEach, expect, test } from "vite-plus/test";

import { greet } from "@/greet";

// The built server is one binary: Vite's client, its files and the telemetry worker are inside it.
// It runs from any folder, with nothing beside it.

const out = mkdtempSync(join(tmpdir(), "binary-"));
const children: Subprocess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

afterAll(() => rmSync(out, { recursive: true, force: true }));

/** The real `build:client`, then the real `build:server` with its outputs in a temp folder. */
async function build() {
  const client = Bun.spawn(["bun", "run", "build:client"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "inherit",
  });
  expect(await client.exited).toBe(0);

  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const script = String(pkg.scripts["build:server"])
    .replace(/--outfile \S+/, `--outfile ${join(out, "server")}`)
    .replace(/--metafile=\S+/, `--metafile=${join(out, "meta.json")}`);
  const made = Bun.spawn(["sh", "-c", script], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "inherit",
  });
  expect(await made.exited).toBe(0);
}

/** Runs the binary from an empty folder; resolves once it listens. */
async function start(collector: string) {
  const child = Bun.spawn([join(out, "server")], {
    cwd: mkdtempSync(join(tmpdir(), "binary-cwd-")),
    env: {
      PATH: process.env.PATH,
      PORT: "0",
      OTEL_SERVICE_NAME: "binary-test",
      VICTORIA_TRACES_URL: `${collector}/traces`,
      VICTORIA_LOGS_URL: `${collector}/logs`,
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  children.push(child);

  const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  for (let next = await lines.read(); !next.done; next = await lines.read()) {
    seen += next.value;
    const url = /tinker: listening on (\S+)/.exec(seen)?.[1];
    if (url) return { child, url: new URL(url) };
  }

  throw new Error(`no listening line: ${seen}`);
}

test("the binary serves the page, its files and rpc, and sends traces from its worker", async () => {
  await build();
  const posts: string[] = [];
  const collector = Bun.serve({
    port: 0,
    fetch: (request) => (posts.push(new URL(request.url).pathname), new Response(null)),
  });
  const { child, url } = await start(`http://localhost:${collector.port}`);

  // A deep link gets the page; each file it links loads from the root.
  const html = await fetch(new URL("/a/b", url)).then((reply) => reply.text());
  const links = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1]!);
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) expect((await fetch(new URL(link, url))).status).toBe(200);

  // rpc over the socket, as a tab calls it.
  const tab = await createScope({
    capsules: [ws.client({ url: `ws://${url.host}/rpc` }), greet.api({ remote: ws.client })],
  }).ready;
  expect(await tab.run(greet.api.greet, { input: { name: "bin" } })).toMatchObject({
    text: expect.stringContaining("bin"),
  });
  await tab.close();

  // A stop flushes the worker: its traces reach the collector.
  child.kill("SIGTERM");
  expect(await child.exited).toBe(143);
  await collector.stop();
  expect(posts).toContain("/traces");
}, 60_000);
