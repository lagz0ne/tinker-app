import { cp, mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

if (import.meta.main) {
  const source = resolve(import.meta.dirname, "..");
  const proof = await mkdtemp(join(tmpdir(), "start-native-middleware-"));
  const previousDirectory = process.cwd();
  try {
    for (const name of [
      "src",
      "tests",
      "drizzle",
      "package.json",
      "vite.config.ts",
      "tsconfig.json",
    ]) {
      await cp(join(source, name), join(proof, name), { recursive: true });
    }
    await symlink(join(source, "node_modules"), join(proof, "node_modules"), "dir");
    await writeFile(
      join(proof, "src/proof-middleware.ts"),
      `
import { createMiddleware } from "@tanstack/react-start";
import { startRequests } from "./scaffold/start.ts";
export const proofRequest = createMiddleware()
  .middleware([startRequests.middleware])
  .server(async ({context, request, next}) => {
    request.headers.set("x-proof-requests", String(Number(request.headers.get("x-proof-requests")) + 1));
    const result = await next({context: {proofSession: context.session, proofRequest: request}});
    result.response.headers.set("x-proof-requests", request.headers.get("x-proof-requests"));
    return result;
  });
export const proofFunction = createMiddleware({type: "function"})
  .middleware([proofRequest])
  .server(({context, next}) => {
    const headers = context.proofRequest.headers;
    headers.set("x-proof-functions", String(Number(headers.get("x-proof-functions")) + 1));
    return next();
  });
`,
    );
    await writeFile(
      join(proof, "src/proof-functions.ts"),
      `
import { createServerFn } from "@tanstack/react-start";
import { proofRequest, proofFunction } from "./proof-middleware.ts";
import { readResult } from "./scaffold/backend/result.server.ts";
import { readProofUser } from "./proof.server.ts";
export const readProof = createServerFn({method: "GET"})
  .middleware([proofRequest, proofFunction, proofFunction])
  .handler(async ({context}) => ({
    user: readResult(await context.session.settle(readProofUser, {signal: context.signal})),
    sameSession: context.session === context.proofSession,
    requestRuns: Number(context.proofRequest.headers.get("x-proof-requests")),
    functionRuns: Number(context.proofRequest.headers.get("x-proof-functions")),
  }));
`,
    );
    await writeFile(
      join(proof, "src/proof.server.ts"),
      `
import { operation } from "@tinker/core";
import { requestHeaders } from "./scaffold/backend/headers.server.ts";
export const readProofUser = operation({
  label: "test.nativeRequest",
  depends: {headers: requestHeaders},
  async run({headers}) {
    await Promise.resolve();
    return headers.get("x-proof-user");
  },
});
`,
    );
    await writeFile(
      join(proof, "src/routes/proof.native.tsx"),
      `
import { createFileRoute } from "@tanstack/react-router";
import { proofRequest } from "../proof-middleware.ts";
import { readProof } from "../proof-functions.ts";
export const Route = createFileRoute("/proof/native")({
  server: {middleware: [proofRequest]},
  loader: async () => ({first: await readProof(), second: await readProof()}),
  component: () => <pre id="native-proof">{JSON.stringify(Route.useLoaderData())}</pre>,
});
`,
    );
    const start = join(proof, "src/start.ts");
    await writeFile(
      start,
      `import { proofRequest } from "./proof-middleware.ts";\n${(await readFile(start, "utf8")).replace("startRequests.middleware,", "startRequests.middleware, proofRequest,")}`,
    );
    const syncRoute = join(proof, "src/routes/api.sync.ts");
    await writeFile(
      syncRoute,
      `import { proofRequest } from "../proof-middleware.ts";\n${(await readFile(syncRoute, "utf8")).replace("middleware: [startRequests.middleware]", "middleware: [startRequests.middleware, proofRequest, proofRequest]")}`,
    );
    await writeFile(
      join(proof, "src/routes/proof.write.ts"),
      `
import { createFileRoute } from "@tanstack/react-router";
import { incrementCounter } from "../backend/index.ts";
import { startRequests } from "../scaffold/start.ts";
import { readResult } from "../scaffold/backend/result.server.ts";
export const Route = createFileRoute("/proof/write")({server: {
  middleware: [startRequests.middleware], handlers: {
    POST: async ({context}) => Response.json(readResult(await context.session.settle(incrementCounter, {input: {executionId: crypto.randomUUID()}}))),
  },
}});
`,
    );
    const entry = join(proof, "src/server.ts");
    await writeFile(
      entry,
      'import { proofDatabase, proofMail } from "../tests/presets.ts";\n' +
        (await readFile(entry, "utf8")).replace(
          "extensions: [setup, startRequests],",
          "extensions: [setup, startRequests], presets: [proofDatabase, proofMail],",
        ),
    );
    const build = spawnSync("vp", ["build"], { cwd: proof, encoding: "utf8" });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    process.chdir(proof);
    Object.assign(process.env, {
      PUBLIC_ORIGIN: "http://localhost:4318",
      AUTH_SECRET: "local-proof-only-secret-with-thirty-two-letters",
      DATABASE_URL: "postgres://proof",
      SMTP_HOST: "proof",
      SMTP_PORT: "25",
      SMTP_USER: "",
      SMTP_PASSWORD: "",
      SMTP_FROM: "proof@example.com",
    });
    const app = await import(pathToFileURL(join(proof, "dist/server/server.js")).href);
    try {
      const results = await Promise.all(
        ["Ada", "Grace"].map(async (user) => {
          const response = await app.default.fetch(
            new Request("http://localhost:4318/proof/native", {
              headers: { "x-proof-user": user },
            }),
          );
          assert.equal(response.status, 200);
          const html = await response.text();
          const content = html.match(/<pre id="native-proof">(?<data>.*?)<\/pre>/)?.groups?.data;
          assert.ok(content, html);
          const data = JSON.parse(content.replaceAll("&quot;", '"'));
          assert.deepEqual(data, {
            first: { user, sameSession: true, requestRuns: 1, functionRuns: 1 },
            second: { user, sameSession: true, requestRuns: 1, functionRuns: 2 },
          });
          return user;
        }),
      );
      const stream = await app.default.fetch(new Request("http://localhost:4318/api/sync"));
      assert.equal(stream.headers.get("x-proof-requests"), "1");
      assert.equal(stream.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
      assert.equal(stream.headers.get("Cache-Control"), "no-store");
      assert.equal(stream.headers.get("X-Accel-Buffering"), "no");
      const reader = stream.body.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), ": connected\n\n");
      const written = await app.default.fetch(
        new Request("http://localhost:4318/proof/write", { method: "POST" }),
      );
      assert.equal(written.status, 200);
      await written.json();
      const frame = new TextDecoder().decode((await reader.read()).value);
      assert.ok(frame.startsWith("event: changes\nid: "), frame);
      assert.ok(frame.endsWith("\n\n"), frame);
      const data = JSON.parse(frame.split("\ndata: ").at(1));
      assert.equal(data.kind, "changes");
      assert.equal(data.events.at(0).payload.change.value, 1);
      const replay = await app.default.fetch(
        new Request(
          "http://localhost:4318/api/sync?cursor=" +
            encodeURIComponent('{"public":2,"private":null}'),
          { headers: { "Last-Event-ID": '{"public":0,"private":null}' } },
        ),
      );
      const repeated = replay.body.getReader();
      assert.equal(new TextDecoder().decode((await repeated.read()).value), frame);
      await repeated.cancel();
      const refused = await app.default.fetch(
        new Request("http://localhost:4318/api/sync", {
          headers: {
            "Last-Event-ID": '{"public":0,"private":{"accountId":"not-signed-in","revision":0}}',
          },
        }),
      );
      assert.equal(refused.status, 403);
      await refused.text();
      const bad = await app.default.fetch(
        new Request("http://localhost:4318/api/sync", { headers: { "Last-Event-ID": "not-json" } }),
      );
      assert.equal(bad.status, 400);
      await bad.text();
      const requestStop = new AbortController();
      const abortedStream = await app.default.fetch(
        new Request(
          "http://localhost:4318/api/sync?cursor=" +
            encodeURIComponent('{"public":2,"private":null}'),
          { signal: requestStop.signal },
        ),
      );
      const abortedReader = abortedStream.body.getReader();
      assert.equal(new TextDecoder().decode((await abortedReader.read()).value), ": connected\n\n");
      const pendingRead = abortedReader.read();
      requestStop.abort();
      assert.equal((await pendingRead).done, true);
      const idle = reader.read();
      await app.close();
      assert.equal((await idle).done, true);
      process.stdout.write(
        "PASS: SSE serializes committed replay, dedupes native middleware, refuses private/bad cursors, and ends idle streams on host close.\n",
      );
      process.stdout.write(
        `PASS: native global/route/function middleware runs once per request; direct SSR calls keep ${results.join(" and ")} apart.\n`,
      );
    } finally {
      await app.close();
    }
  } finally {
    process.chdir(previousDirectory);
    await rm(proof, { recursive: true, force: true });
  }
}
