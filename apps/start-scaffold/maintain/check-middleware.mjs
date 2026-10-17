import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { copyProofApp, proofEnv } from "./proof-app.mjs";

if (import.meta.main) {
  const source = resolve(import.meta.dirname, "..");
  const proof = await mkdtemp(join(tmpdir(), "start-native-middleware-"));
  const previousDirectory = process.cwd();
  try {
    await copyProofApp(source, proof);

    const plant = process.argv.find((arg) => arg.startsWith("--plant="))?.slice(8);
    if (plant) {
      assert.ok(["sync", "auth", "telemetry", "functions"].includes(plant));
      const requests = join(proof, "tinker/components/requests");
      const copy = (await readFile(join(requests, "start.ts"), "utf8")).replace(
        'label: "start.requests"',
        'label: "start.requests.second"',
      );
      await writeFile(join(requests, "second-start.ts"), copy);

      const index = join(requests, "index.ts");
      await writeFile(
        index,
        (await readFile(index, "utf8")) +
          '\nexport { startRequests as secondStartRequests } from "./second-start";\n',
      );
      const target = join(
        proof,
        plant === "functions"
          ? "tinker/components/sync/functions.ts"
          : `src/routes/api.${plant}${plant === "auth" ? ".$" : ""}.ts`,
      );
      const original = await readFile(target, "utf8");
      assert.ok(
        original.includes("import { startRequests }"),
        "the plant must replace the real boundary middleware",
      );
      await writeFile(
        target,
        original.replace(
          "import { startRequests }",
          "import { secondStartRequests as startRequests }",
        ),
      );
    }

    // Expose only the existing native function in this proof fixture to read its HTTP URL.
    const syncIndex = join(proof, "tinker/components/sync/index.ts");
    await writeFile(
      syncIndex,
      (await readFile(syncIndex, "utf8")) +
        '\nexport { getBootstrap } from "~/components/sync/functions";\n',
    );

    const serverFile = join(proof, "cmds/server.ts");
    const server = await readFile(serverFile, "utf8");
    assert.ok(server.includes("    app.onClose("));
    await writeFile(
      serverFile,
      server.replace(
        "    app.onClose(",
        `
  const createRequestSession = app.createSession.bind(app);
  let requestSessionCount = 0;
  app.createSession = (...args) => { requestSessionCount++; return createRequestSession(...args); };
  Object.assign(globalThis, { __middlewareProof: {
    count: () => requestSessionCount,
    stdout: tools.resolve(consoleOutput) === stdout,
  } });
    app.onClose(
`,
      ),
    );

    await writeFile(
      join(proof, "src/proof-middleware.ts"),
      `
import { createMiddleware } from "@tanstack/react-start";
import { startRequests } from "~/components/requests";
export const proofRequest = createMiddleware()
  .middleware([startRequests.middleware])
  .server(async ({context, request, next}) => {
    request.headers.set("x-proof-requests", String(Number(request.headers.get("x-proof-requests")) + 1));
    const result = await next({context: {proofSession: context.session, proofRequest: request}});
    result.response.headers.set("x-proof-requests", request.headers.get("x-proof-requests") ?? "0");
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
import { proofRequest, proofFunction } from "./proof-middleware";
import { readResult } from "~/components/requests/index.server";
import { readProofUser } from "./proof.server";
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
import { requestHeaders } from "~/components/requests/index.server";
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
import { proofRequest } from "../proof-middleware";
import { readProof } from "../proof-functions";
import { getBootstrap } from "~/components/sync";
export const Route = createFileRoute("/proof/native")({
  server: {middleware: [proofRequest]},
  loader: async () => ({first: await readProof(), second: await readProof(), bootstrapUrl: getBootstrap.url}),
  component: () => <pre id="native-proof">{JSON.stringify(Route.useLoaderData())}</pre>,
});
`,
    );

    await writeFile(
      join(proof, "src/start.ts"),
      `
import { createStart } from "@tanstack/react-start";
import { proofRequest } from "./proof-middleware";
export const startInstance = createStart(() => ({requestMiddleware: [proofRequest]}));
`,
    );

    await writeFile(
      join(proof, "src/routes/proof.write.ts"),
      `
import { createFileRoute } from "@tanstack/react-router";
import { incrementCounter } from "@/demo/index.server";
import { startRequests } from "~/components/requests";
import { readResult } from "~/components/requests/index.server";
export const Route = createFileRoute("/proof/write")({server: {
  middleware: [startRequests.middleware], handlers: {
    POST: async ({context}) => Response.json(readResult(await context.session.settle(incrementCounter, {input: {executionId: crypto.randomUUID()}}))),
  },
}});
`,
    );

    const build = spawnSync("vp", ["build"], { cwd: proof, encoding: "utf8" });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    process.chdir(proof);
    Object.assign(process.env, proofEnv);
    const built = await import(pathToFileURL(join(proof, "dist/server/server.js")).href);

    const stop = new AbortController();
    const app = await built.default({
      env: process.env,
      args: [],
      exit(_code, reason) {
        stop.abort(reason);
      },
      signal: stop.signal,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    try {
      const native = globalThis.__middlewareProof;
      let bootstrapUrl;
      assert.equal(native.stdout, true, "the command binds stdout to its telemetry tools");
      const results = await Promise.all(
        ["Ada", "Grace"].map(async (user) => {
          const response = await app.fetch(
            new Request("http://localhost:4318/proof/native", {
              headers: { "x-proof-user": user },
            }),
          );
          assert.equal(response.status, 200);
          const html = await response.text();
          const content = html.match(/<pre id="native-proof">(?<data>.*?)<\/pre>/)?.groups?.data;
          assert.ok(content, html);

          const data = JSON.parse(content.replaceAll("&quot;", '"'));
          bootstrapUrl = data.bootstrapUrl;
          assert.ok(bootstrapUrl.includes("_serverFn"), bootstrapUrl);
          delete data.bootstrapUrl;
          assert.deepEqual(data, {
            first: { user, sameSession: true, requestRuns: 1, functionRuns: 1 },
            second: { user, sameSession: true, requestRuns: 1, functionRuns: 2 },
          });

          return user;
        }),
      );

      assert.equal(native.count(), 2, "one request session per SSR request");

      const stream = await app.fetch(new Request("http://localhost:4318/api/sync"));
      assert.equal(native.count(), 3, "one request session for /api/sync");

      const auth = await app.fetch(new Request("http://localhost:4318/api/auth/get-session"));
      assert.equal(native.count(), 4, "one request session for /api/auth");
      assert.equal(auth.status, 200);
      await auth.text();

      const telemetry = await app.fetch(
        new Request("http://localhost:4318/api/telemetry", {
          method: "POST",
          headers: { Origin: "http://localhost:4318", "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      assert.equal(native.count(), 5, "one request session for /api/telemetry");
      assert.equal(telemetry.status, 400);
      await telemetry.text();

      const bootstrap = await app.fetch(
        new Request(new URL(bootstrapUrl, "http://localhost:4318"), {
          headers: { "Sec-Fetch-Site": "same-origin", "x-tsr-serverFn": "true" },
        }),
      );
      assert.equal(bootstrap.status, 200, await bootstrap.clone().text());
      const bootstrapBody = await bootstrap.text();
      assert.ok(bootstrapBody.includes('"public"'), bootstrapBody);
      assert.ok(!bootstrapBody.includes("StartSessionAlreadySet"), bootstrapBody);
      console.log("PASS: HTTP getBootstrap returned its snapshot with one session.");
      assert.equal(native.count(), 6, "one request session for HTTP getBootstrap");

      const health = await app.fetch(new Request("http://localhost:4318/api/health"));
      assert.equal(health.status, 200);
      await health.text();
      assert.equal(native.count(), 7, "one request session for /api/health");

      assert.equal(stream.headers.get("x-proof-requests"), "1");
      assert.equal(stream.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
      assert.equal(stream.headers.get("Cache-Control"), "no-store");
      assert.equal(stream.headers.get("X-Accel-Buffering"), "no");
      const reader = stream.body.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), ": connected\n\n");

      const written = await app.fetch(
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

      const replay = await app.fetch(
        new Request(
          "http://localhost:4318/api/sync?cursor=" +
            encodeURIComponent('{"public":2,"private":null}'),
          { headers: { "Last-Event-ID": '{"public":0,"private":null}' } },
        ),
      );
      const repeated = replay.body.getReader();
      assert.equal(new TextDecoder().decode((await repeated.read()).value), frame);
      await repeated.cancel();

      const refused = await app.fetch(
        new Request("http://localhost:4318/api/sync", {
          headers: {
            "Last-Event-ID": '{"public":0,"private":{"accountId":"not-signed-in","revision":0}}',
          },
        }),
      );
      assert.equal(refused.status, 403);
      await refused.text();

      const bad = await app.fetch(
        new Request("http://localhost:4318/api/sync", { headers: { "Last-Event-ID": "not-json" } }),
      );
      assert.equal(bad.status, 400);
      await bad.text();

      const requestStop = new AbortController();
      const abortedStream = await app.fetch(
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
      stop.abort();
      await app.closed;
      assert.equal((await idle).done, true);

      process.stdout.write(
        "PASS: SSE serializes committed replay, dedupes native middleware, refuses private/bad cursors, and ends idle streams on host close.\n",
      );
      process.stdout.write(
        `PASS: native global/route/function middleware runs once per request; direct SSR calls keep ${results.join(" and ")} apart.\n`,
      );
    } finally {
      stop.abort();
      await app.closed;
    }
  } finally {
    process.chdir(previousDirectory);
    await rm(proof, { recursive: true, force: true });
  }
}
