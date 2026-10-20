import { spawn } from "node:child_process";
import { request } from "node:http";
import { join } from "node:path";

import { expect, onTestFinished, test } from "vite-plus/test";

import { baseDir } from "../lib/paths.mjs";
import { fixture } from "./fixture.mjs";

/**
 * A built server: `/wait` answers when its signal aborts; `/last` reports the previous signal;
 * `/json` is a whole JSON body; `/html` streams its second part late; `/lines`, a `+json`
 * stream, stays open until `/release`; `/big` is 96 KiB of JSON in one part; `/failed` and
 * `/failed-stream` lend a join that rejects.
 */
const app = `
let last;
let release;
const text = new TextEncoder();

function lines() {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(text.encode('{"n":1}\\n'));
      release = () => {
        controller.enqueue(text.encode('{"n":2}\\n'));
        controller.close();
      };
    },
  });
  return new Response(body, { headers: { "content-type": "application/stream+json" } });
}

function failed(request, response) {
  request.runtime.beforeEnd = () => Promise.reject(new Error("commit failed"));
  return response;
}

function json() {
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("set-cookie", "a=1");
  headers.append("set-cookie", "b=2");
  return Response.json({ word: "café" }, { status: 201, headers });
}

function html() {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(text.encode("<p>shell</p>"));
      setTimeout(() => {
        controller.enqueue(text.encode("<p>late</p>"));
        controller.close();
      }, 50);
    },
  });
  return new Response(body, { headers: { "content-type": "text/html" } });
}

export default async function main({ signal }) {
  const closed = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  return {
    closed,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/last") return new Response(String(last.aborted));
      if (path === "/json") return json();
      if (path === "/html") return html();
      if (path === "/lines") return lines();
      if (path === "/big") return Response.json("x".repeat(96 * 1024));
      if (path === "/failed") return failed(request, new Response("hello"));
      if (path === "/failed-stream") return failed(request, html());
      if (path === "/release") {
        release();
        return new Response(null, { status: 204 });
      }

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
async function get(port, path) {
  return (await read(port, path)).body;
}

/**
 * @param {number} port - From serve; why: the host under test.
 * @param {string} path - From a test; why: the route to read.
 */
function read(port, path) {
  return new Promise((resolve, reject) => {
    request({ port, path }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode, headers: response.headers, body }),
      );
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

test("a whole JSON body goes out with its length, status, and every cookie", async () => {
  const { port } = await serve();

  const { status, headers, body } = await read(port, "/json");

  expect(status).toBe(201);
  expect(body).toBe('{"word":"café"}');
  expect(headers["content-length"]).toBe(String(Buffer.byteLength(body)));
  expect(headers["set-cookie"]).toEqual(["a=1", "b=2"]);
  expect(headers["cache-control"]).toBe("no-store");
});

test("streamed HTML still goes out in parts", async () => {
  const { port } = await serve();

  const { headers, body } = await read(port, "/html");

  expect(headers["transfer-encoding"]).toBe("chunked");
  expect(body).toBe("<p>shell</p><p>late</p>");
});

test("a live JSON stream sends each line before the producer closes", async () => {
  const { port } = await serve();
  const parts = [];

  await new Promise((resolve, reject) => {
    request({ port, path: "/lines" }, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        parts.push(chunk);
        if (parts.length === 1) void get(port, "/release");
      });
      response.on("end", resolve);
    })
      .on("error", reject)
      .end();
  });

  expect(parts.join("")).toBe('{"n":1}\n{"n":2}\n');
  expect(parts[0]).toBe('{"n":1}\n');
});

test("a body over 64 KiB streams rather than waiting for its length", async () => {
  const { port } = await serve();

  const { headers, body } = await read(port, "/big");

  expect(headers["content-length"]).toBeUndefined();
  expect(headers["transfer-encoding"]).toBe("chunked");
  expect(body).toBe(JSON.stringify("x".repeat(96 * 1024)));
});

test.each(["/failed", "/failed-stream"])(
  "a request that cannot close fails its reply at %s",
  async (path) => {
    const { port } = await serve();

    const reply = new Promise((resolve) => {
      request({ port, path }, (response) => {
        response.on("error", () => resolve("broken"));
        response.on("end", () => resolve(response.complete ? "complete" : "broken"));
        response.resume();
      })
        .on("error", () => resolve("broken"))
        .end();
    });

    expect(await reply).toBe("broken");
  },
);
