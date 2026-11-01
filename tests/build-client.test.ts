import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "build-client-"));

afterAll(() => rmSync(out, { recursive: true, force: true }));

test("the client build links its files from the root, so a deep link like /a/b loads them", async () => {
  // The real `build:client` script, with its output moved to a temp folder.
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const args = String(pkg.scripts["build:client"])
    .split(" ")
    .slice(1)
    .map((arg) => arg.replace(/^dist\/client$/, join(out, "client")))
    .map((arg) => arg.replace(/^--metafile=.*/, `--metafile=${join(out, "meta.json")}`));
  const build = Bun.spawn([process.execPath, ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "inherit",
  });
  expect(await build.exited).toBe(0);

  const html = await Bun.file(join(out, "client", "index.html")).text();
  const files = readdirSync(join(out, "client")).filter((name) => name !== "index.html");
  const links = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1] ?? "")
    .filter((link) => files.some((name) => link.endsWith(name)));
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) expect(link).toStartWith("/");
}, 30_000);
