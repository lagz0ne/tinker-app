import { afterEach, expect, test } from "bun:test";

import type { Subprocess } from "bun";

const children: Subprocess[] = [];

/** A failed test must not leave its host running: `bun test` would wait for it. */
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/** Reads a host's stdout lines to their end. */
const rest = async (lines: ReadableStreamDefaultReader<string>) => {
  let text = "";
  for (let next = await lines.read(); !next.done; next = await lines.read()) text += next.value;
  return text;
};

/**
 * Runs a fixture host on a free port; resolves its URL from the `tinker: listening` line. `rest`
 * reads the host's stdout to its end.
 */
const host = async (fixture: string) => {
  const child = Bun.spawn(
    [process.execPath, new URL(`fixtures/${fixture}`, import.meta.url).pathname],
    {
      env: { ...process.env, PORT: "0" },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  children.push(child);

  const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  for (let next = await lines.read(); !next.done; next = await lines.read()) {
    seen += next.value;
    const url = /tinker: listening on (\S+)/.exec(seen)?.[1];
    if (url) return { child, url: new URL(url), seen, rest: () => rest(lines) };
  }
  return { child, url: undefined, seen, rest: () => rest(lines) };
};

test("a stream quiet for longer than Bun's 10 s default is not reset", async () => {
  const { child, url } = await host("stream-host.ts");
  expect(url).toBeDefined();

  const text = await fetch(new URL("/api/stream", url)).then((reply) => reply.text());
  expect(text).toBe("one\ntwo\n");

  child.kill("SIGTERM");
  expect(await child.exited).toBe(143);
}, 30_000);

test("a command that exits during start exits with its code and never listens", async () => {
  const child = Bun.spawn(
    [process.execPath, new URL("fixtures/exit-host.ts", import.meta.url).pathname],
    {
      env: { ...process.env, PORT: "0" },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  children.push(child);

  const stdout = await new Response(child.stdout).text();
  expect(await child.exited).toBe(64);
  expect(stdout).not.toContain("tinker: listening");
});

test("a command that exits during start still waits for its root to close, and never listens", async () => {
  const child = Bun.spawn(
    [process.execPath, new URL("fixtures/exit-closed-host.ts", import.meta.url).pathname],
    {
      env: { ...process.env, PORT: "0" },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  children.push(child);

  const stdout = await new Response(child.stdout).text();
  expect(await child.exited).toBe(64);
  expect(stdout).toContain("closed\n");
  expect(stdout).not.toContain("tinker: listening");
});

test("extra paths go to the command, beside /api/* and /rpc/*", async () => {
  const { url } = await host("paths-host.ts");
  const text = (path: string) => fetch(new URL(path, url)).then((reply) => reply.text());

  expect(await text("/mcp")).toBe("cmd");
  expect(await text("/.well-known/x")).toBe("cmd");
  expect(await text("/api/x")).toBe("cmd");
  expect(await text("/rpc/x")).toBe("cmd");
  expect(await text("/a/b")).toBe("page");
});

test("with no extra paths, /mcp gets the page", async () => {
  const { url } = await host("page-host.ts");
  const text = (path: string) => fetch(new URL(path, url)).then((reply) => reply.text());

  expect(await text("/mcp")).toBe("page");
  expect(await text("/api/x")).toBe("cmd");
});

test("a hang-up (SIGHUP) closes the port and the root, then exits 129", async () => {
  const { child, url, rest } = await host("page-host.ts");
  expect(url).toBeDefined();

  child.kill("SIGHUP");

  expect(await child.exited).toBe(129);
  // Bun's own hang-up exit also reads 129; a kill by the signal sets signalCode.
  expect(child.signalCode).toBeNull();
  expect(await rest()).toContain("closed\n");
});
