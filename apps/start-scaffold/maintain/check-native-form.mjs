import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { promisify } from "node:util";

const source = await readFile(
  process.env.BOARD_NATIVE_FORM_SOURCE ?? new URL("../src/frontend/App.tsx", import.meta.url),
  "utf8",
);

const opening = source.match(/<form\b([\s\S]*?)onSubmit=/)?.[1] ?? "";
const method = opening.match(/method="([^"]+)"/)?.[1];

if (!process.env.BOARD_NATIVE_FORM_SOURCE) {
  const registry = JSON.parse(
    await readFile(new URL("../public/r/registry.json", import.meta.url), "utf8"),
  );
  const file = registry.items
    .flatMap((item) => item.files ?? [])
    .find((file) => file.path === "src/frontend/App.tsx");
  assert.equal(file.content, source, "registry must ship the checked source form");
}

const received = Promise.withResolvers();

const server = createServer(async (request, response) => {
  if (request.url === "/") {
    response.setHeader("content-type", "text/html");
    response.end(
      `<form ${method ? `method="${method}"` : ""} action="/submitted"><input name="email" value="native@example.test"><input name="password" type="password" value="fake-native-password"><button>Submit</button></form>`,
    );
    return;
  }
  if (!request.url.startsWith("/submitted")) {
    response.writeHead(404).end();
    return;
  }

  let body = "";
  for await (const chunk of request) body += chunk;
  received.resolve({ method: request.method, url: request.url, body });
  response.end("Submitted");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const session = "native-form-" + process.pid;

const browser = async (...args) => {
  const { stdout } = await promisify(execFile)(
    "agent-browser",
    ["--engine", "lightpanda", "--session", session, "--json", ...args],
    { timeout: 35000 },
  );
  const result = JSON.parse(stdout);
  assert(result.success, result.error);
};

try {
  await browser("open", `http://127.0.0.1:${server.address().port}`);
  await browser("click", "button");

  const deadline = setTimeout(
    () => received.reject(new Error("native submit did not reach server")),
    5000,
  );
  const submission = await received.promise.finally(() => clearTimeout(deadline));

  assert.equal(submission.method, "POST", "native submit must POST without URL credentials");
  assert.equal(submission.url, "/submitted", "credentials must not enter the URL");
  assert.equal(new URLSearchParams(submission.body).get("password"), "fake-native-password");

  console.log(
    "PASS native submit: credentials stay in POST body; rebuilt registry matches source.",
  );
} finally {
  await browser("close");
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
