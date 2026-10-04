import { test, expect } from "vite-plus/test";
import { createScope } from "@tinker/core";
import {
  databaseSettings,
  mailSettings,
  authSettings,
  migrate,
  raise,
} from "@tinker-start-scaffold/backend";
import {
  browserTelemetry,
  telemetryOrigin,
  backendStop,
  requestStop,
} from "@tinker-start-scaffold/transport";
import { proofDatabase, proofMail, requestHeaders } from "@tinker-start-scaffold/testing";
import { Route as telemetryRoute } from "../src/routes/api.telemetry.ts";
import { Route as syncRoute } from "../src/routes/api.sync.ts";

const telemetryHandlers = telemetryRoute.options.server?.handlers;
const syncHandlers = syncRoute.options.server?.handlers;
if (
  !telemetryHandlers ||
  typeof telemetryHandlers === "function" ||
  !syncHandlers ||
  typeof syncHandlers === "function"
)
  raise("BadInput", { reason: "Expected route handler records" });
const telemetryPost = telemetryHandlers.POST;
const syncGet = syncHandlers.GET;
if (typeof telemetryPost !== "function" || typeof syncGet !== "function")
  raise("BadInput", { reason: "Expected route methods" });
const batch = { logs: [], traces: [] };

function telemetryRequest(row: {
  origin?: string;
  type?: string;
  length?: string;
  body?: string | null;
}) {
  const headers = new Headers({
    origin: row.origin ?? "http://localhost",
    "content-type": row.type ?? "application/json; charset=utf-8",
  });
  if (row.length) headers.set("content-length", row.length);
  return new Request("http://localhost/api/telemetry", {
    method: "POST",
    headers,
    body: row.body === null ? null : (row.body ?? JSON.stringify(batch)),
  });
}

async function readWire(response: Response) {
  const reader = response.body?.getReader();
  const body = reader ? new TextDecoder().decode((await reader.read()).value) : "";
  await reader?.cancel();
  return { status: response.status, headers: [...response.headers], body };
}

test("telemetry wire keeps status, all headers, and body for each input case", async () => {
  const stop = new AbortController();
  const accepted: unknown[] = [];
  const root = createScope({
    tags: [
      telemetryOrigin("http://localhost"),
      backendStop(stop.signal),
      requestStop(stop.signal),
      browserTelemetry(async (value) => {
        accepted.push(value);
      }),
    ],
  });
  await root.ready;
  try {
    const cases = [
      { name: "good batch", body: JSON.stringify(batch), status: 202 },
      { name: "bad origin", origin: "http://other.test", status: 403 },
      { name: "wrong type", type: "text/plain", status: 415 },
      { name: "too large header", length: "65537", status: 413 },
      { name: "too large body", body: " ".repeat(65537), status: 413 },
      { name: "bad body", body: "{", status: 400 },
      { name: "bad shape", body: '{"logs":[],"traces":[],"extra":true}', status: 400 },
      {
        name: "server record",
        body: JSON.stringify({
          logs: [{ time: 1, level: 30, msg: "x", side: "server", service: "x" }],
          traces: [],
        }),
        status: 400,
      },
      { name: "no body", body: null, status: 400 },
      { name: "closed backend", closed: true, status: 503 },
    ];
    for (const row of cases) {
      if (row.closed) stop.abort();
      const session = root.createSession();
      const request = telemetryRequest(row);
      const response = await telemetryPost({
        request,
        context: { session, signal: request.signal },
        params: {},
        pathname: "/api/telemetry",
        next: () => raise("BadInput", { reason: "Route must reply" }),
      });
      if (!(response instanceof Response)) throw response;
      expect(await readWire(response), row.name).toEqual({
        status: row.status,
        headers: row.status === 202 ? [["cache-control", "no-store"]] : [],
        body: "",
      });
      expect((await session.close({ graceful: true })).status).toBe("success");
    }
    expect(accepted).toEqual([batch]);
  } finally {
    expect((await root.close({ graceful: true })).status).toBe("success");
  }
});

test("sync wire keeps open, Last-Event-ID precedence, and bad cursor replies", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [
      databaseSettings({ url: "postgres://proof", migrations: "drizzle" }),
      mailSettings({
        host: "proof",
        port: 25,
        user: "proof",
        password: "proof",
        from: "proof@example.com",
      }),
      authSettings({
        origin: "http://localhost:4318",
        secret: "test-secret-with-at-least-thirty-two-letters",
        plugins: [],
      }),
      backendStop(stop.signal),
      requestStop(stop.signal),
      requestHeaders(new Headers()),
    ],
    presets: [proofDatabase, proofMail],
  });
  await root.ready;
  try {
    await root.run(migrate);
    for (const row of [
      { name: "open", search: "", last: null, status: 200 },
      { name: "resume", search: "?cursor=bad", last: '{"public":0,"private":null}', status: 200 },
      { name: "bad cursor", search: "?cursor=bad", last: null, status: 400 },
      { name: "bad cursor shape", search: "?cursor=%7B%7D", last: null, status: 400 },
    ]) {
      const session = root.createSession();
      const request = new Request(`http://localhost/api/sync${row.search}`, {
        headers: row.last ? { "Last-Event-ID": row.last } : {},
      });
      const response = await syncGet({
        request,
        context: { session, signal: request.signal },
        params: {},
        pathname: "/api/sync",
        next: () => raise("BadInput", { reason: "Route must reply" }),
      });
      if (!(response instanceof Response)) throw response;
      expect(await readWire(response), row.name).toEqual({
        status: row.status,
        headers:
          row.status === 200
            ? [
                ["cache-control", "no-store"],
                ["content-type", "text/event-stream; charset=utf-8"],
                ["x-accel-buffering", "no"],
              ]
            : [],
        body: row.status === 200 ? ": connected\n\n" : "",
      });
      expect((await session.close({ graceful: true })).status).toBe("success");
    }
  } finally {
    stop.abort();
    expect((await root.close({ graceful: true })).status).toBe("success");
  }
});
