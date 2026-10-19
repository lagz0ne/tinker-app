import { spawn } from "node:child_process";
import { request } from "node:http";
import { join } from "node:path";

import { expect, onTestFinished, test } from "vite-plus/test";

import { baseDir } from "../lib/paths.mjs";
import { fixture } from "./fixture.mjs";

/** A built server: `/wait` answers when its signal aborts; `/last` reports the previous signal. */
const app = `
let last;
export default async function main({ signal }) {
  const closed = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  return {
    closed,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/last") return new Response(String(last.aborted));

      last = request.signal;
      if (path === "/wait") {
        await new Promise((resolve) => last.addEventListener("abort", resolve, { once: true }));
        console.log("aborted: " + last.reason);
      }
      return new Response("done");
    },
  };
}
`;

/** Starts tinker serve on a free port; the test's end stops it. */
async function serve() {
  const root = fixture({
    "package.json": '{"type":"module"}',
    "dist/server/server.js": app,
  });
  const child = spawn(process.execPath, [join(baseDir, "bin/tinker.mjs"), "serve"], {
    cwd: root,
    env: { ...process.env, PORT: "0" },
  });
  onTestFinished(() => child.kill("SIGTERM"));

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  const port = await new Promise((resolve) =>
    child.stdout.on("data", () => {
      const listening = /tinker serve: http:\/\/[^:]+:(\d+)/.exec(output);
      if (listening) resolve(Number(listening[1]));
    }),
  );
  return { port, printed: () => output };
}

/**
 * @param {number} port - From serve; why: the host under test.
 * @param {string} path - From a test; why: the route to read.
 */
function get(port, path) {
  return new Promise((resolve, reject) => {
    request({ port, path }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve(body));
    })
      .on("error", reject)
      .end();
  });
}

test("a request's signal aborts when the client leaves before the response", async () => {
  const { port, printed } = await serve();

  const leaving = request({ port, path: "/wait" }).on("error", () => {});
  leaving.end();
  await new Promise((resolve) => setTimeout(resolve, 200));
  leaving.destroy();
  await expect.poll(printed).toContain("aborted: Error: aborted");
});

test("a request's signal stays open once its response finished", async () => {
  const { port } = await serve();

  expect(await get(port, "/done")).toBe("done");
  expect(await get(port, "/last")).toBe("false");
});
