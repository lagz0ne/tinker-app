import { afterEach, expect, test } from "bun:test";

import type { Subprocess } from "bun";

const children: Subprocess[] = [];

/** A failed test must not leave its host running: `bun test` would wait for it. */
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/** Runs a fixture host on a free port; resolves its URL from the `tinker: listening` line. */
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
    if (url) return { child, url: new URL(url), seen };
  }
  return { child, url: undefined, seen };
};

test("a stream quiet for longer than Bun's 10 s default is not reset", async () => {
  const { child, url } = await host("stream-host.ts");
  expect(url).toBeDefined();

  const text = await fetch(new URL("/api/stream", url)).then((reply) => reply.text());
  expect(text).toBe("one\ntwo\n");

  child.kill("SIGTERM");
  expect(await child.exited).toBe(143);
}, 30_000);
