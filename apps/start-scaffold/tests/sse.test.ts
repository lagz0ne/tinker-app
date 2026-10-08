import { streamMessage } from "../src/lib/tinker";
import { env } from "@tinker/start/server";
import { handleAuth } from "@tinker-start-scaffold/testing";
import { test, expect } from "vite-plus/test";
import { createScope, operation } from "@tinker/core";
import { preset, makeTestClock } from "@tinker/core/testing";
import { proofDatabase, proofMail, requestHeaders } from "@tinker-start-scaffold/testing";
import {
  database,
  migrate,
  incrementCounter,
  bootstrapPrivate,
  saveProfile,
  isError,
  raise,
  mail,
} from "@tinker-start-scaffold/backend";
import type { Mail } from "@tinker-start-scaffold/backend";
import { syncClient, applyBootstrap } from "@tinker/start/client";
import { accountOwner, tabStop, receiveMessage } from "@tinker/start/testing";
import { openSync, notifications, backendStop, requestStop } from "@tinker/start/testing";

const settings = env({
  DATABASE_URL: "postgres://proof",
  SMTP_HOST: "proof",
  SMTP_PORT: "25",
  SMTP_USER: "proof",
  SMTP_PASSWORD: "proof",
  SMTP_FROM: "proof@example.com",
  PUBLIC_ORIGIN: "http://localhost:4318",
  AUTH_SECRET: "test-secret-with-at-least-thirty-two-letters",
});

function signup(name: string) {
  return new Request("http://localhost:4318/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:4318" },
    body: JSON.stringify({ name, email: `${name}@example.com`, password: "safe-password-42" }),
  });
}

function headers(response: Response) {
  return new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";").at(0))
      .join("; "),
  });
}

const rollBackEvent = operation({
  label: "test.rollbackEvent",
  depends: { database },
  run: async ({ database }) => {
    const { sql } = await import("drizzle-orm");
    await database.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO sync_event (stream, revision, "executionId", payload) VALUES ('public', 99, '00000000-0000-4000-8000-000000000001', '{}')`,
      );
      raise("Rollback", {});
    });
  },
});

/** Session wakes hide the heartbeat fallback; only this test database drops that trigger. */
const disableSessionWake = operation({
  label: "test.disableSessionWake",
  depends: { database },
  run: async ({ database }) => {
    const { sql } = await import("drizzle-orm");
    await database.execute(sql`DROP TRIGGER sync_session_changed ON session`);
  },
});

test("SQL notifications wake after commit, stay silent on rollback, and survive a read before waiting", async () => {
  const stop = new AbortController();
  const root = createScope({
    signal: stop.signal,
    tags: settings,
    presets: [proofDatabase, proofMail],
  });
  await root.ready;
  try {
    await root.run(migrate);
    const feed = await root.resolve(notifications);
    const subscription = await feed.subscribe();
    const before = feed.revision();
    const refused = await root.settle(rollBackEvent);
    if (refused.status !== "failed" || !isError(refused.error, "Rollback")) throw refused;
    expect(feed.revision()).toBe(before);
    await root.run(incrementCounter, { input: { executionId: crypto.randomUUID() } });
    await feed.wait(subscription, before);
    expect(feed.revision()).toBeGreaterThan(before);
    feed.close(subscription);
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("SSE replays the supplied cursor and a held reader receives the next committed batch", async () => {
  const stop = new AbortController();
  const root = createScope({
    signal: stop.signal,
    tags: [
      settings,
      backendStop(stop.signal),
      requestStop(stop.signal),
      requestHeaders(new Headers()),
    ],
    presets: [proofDatabase, proofMail],
  });
  await root.ready;
  try {
    await root.run(migrate);
    await root.run(incrementCounter, { input: { executionId: crypto.randomUUID() } });
    const response = await root.run(openSync, {
      input: { cursor: { public: 0, private: null } },
    });
    const reader = response.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('id: {"public":2,"private":null}');
    expect(first).toContain('"value":1');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
    const waiting = reader.read();
    await root.run(incrementCounter, { input: { executionId: crypto.randomUUID() } });
    expect(new TextDecoder().decode((await waiting).value)).toContain('"value":2');
    const idle = reader.read();
    await reader.cancel();
    expect((await idle).done).toBe(true);
    const openingStop = new AbortController();
    const openingRequest = root.createSession({ tags: requestStop(openingStop.signal) });
    const opening = openingRequest.settle(openSync, {
      input: { cursor: { public: 4, private: null } },
    });
    openingStop.abort();
    const aborted = await opening;
    if (aborted.status !== "failed" || !isError(aborted.error, "Cancelled")) throw aborted;
    expect((await openingRequest.close({ graceful: true })).status).toBe("success");
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("private SSE cursors are refused and a revoked held stream sends no saved private rows", async () => {
  const stop = new AbortController();
  const root = createScope({
    signal: stop.signal,
    tags: [settings, backendStop(stop.signal), requestStop(stop.signal)],
    presets: [proofDatabase, proofMail],
  });
  await root.ready;
  try {
    await root.run(migrate);
    const ada = headers(
      await root.run(handleAuth, { input: signup("Ada"), tags: requestHeaders(new Headers()) }),
    );
    const grace = headers(
      await root.run(handleAuth, { input: signup("Grace"), tags: requestHeaders(new Headers()) }),
    );
    const snapshot = await root.run(bootstrapPrivate, { tags: requestHeaders(ada) });
    const cursor = {
      public: 0,
      private: { accountId: snapshot.stream, revision: snapshot.revision },
    };
    const other = root.createSession({ tags: requestHeaders(grace) });
    const refused = await other.settle(openSync, {
      input: { cursor },
    });
    if (refused.status !== "failed" || !isError(refused.error, "StreamDenied")) throw refused;
    await other.close();
    const owner = root.createSession({ tags: requestHeaders(ada) });
    const response = await owner.run(openSync, { input: { cursor } });
    await root.run(saveProfile, {
      tags: requestHeaders(ada),
      input: { executionId: crypto.randomUUID(), profile: { name: "Never sent after revocation" } },
    });
    await root.run(handleAuth, {
      tags: requestHeaders(ada),
      input: new Request("http://localhost:4318/api/auth/sign-out", {
        method: "POST",
        headers: new Headers([...ada, ["origin", "http://localhost:4318"]]),
      }),
    });
    const reader = response.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      'event: account\ndata: {"kind":"account-change"}\n\n',
    );
    expect((await reader.read()).done).toBe(true);
    expect((await owner.close({ graceful: true })).status).toBe("success");
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("reconnecting from applied cursors finishes a save whose final event committed while disconnected", async () => {
  const stop = new AbortController();
  const sending = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<void>();
  const server = createScope({
    signal: stop.signal,
    tags: [settings, backendStop(stop.signal), requestStop(stop.signal)],
    presets: [
      proofDatabase,
      preset(mail, async () => ({
        async send(message: Mail.Message) {
          if (message.subject === "Your profile was updated") {
            sending.resolve();
            await accepted.promise;
          }
        },
      })),
    ],
  });
  const browser = createScope({
    signal: stop.signal,
    extensions: [accountOwner],
    tags: tabStop(stop.signal),
  });
  await Promise.all([server.ready, browser.ready]);
  try {
    await server.run(migrate);
    const ada = headers(
      await server.run(handleAuth, { input: signup("Ada"), tags: requestHeaders(new Headers()) }),
    );
    const initial = await server.run(bootstrapPrivate, { tags: requestHeaders(ada) });
    browser.run(applyBootstrap, {
      input: {
        version: 0,
        snapshot: { public: { stream: "public", revision: 0, value: 0 }, private: initial },
      },
    });
    const client = browser.resolve(syncClient);
    const executionId = crypto.randomUUID();
    const save = operation({
      label: "test.pendingSave",
      depends: { sync: syncClient },
      run: async ({ sync }, { signal }) =>
        sync.execute(
          executionId,
          {
            data: undefined,
            send: async () => {
              await server.run(saveProfile, {
                input: { executionId, profile: { name: "Saved while offline" } },
                tags: requestHeaders(ada),
              });
              return { kind: "accepted", executionId };
            },
          },
          signal,
        ),
    });
    const waiting = browser.run(save);
    await sending.promise;
    const first = server.createSession({ tags: requestHeaders(ada) });
    const response = await first.run(openSync, {
      input: { cursor: { public: 0, private: { accountId: initial.stream, revision: 0 } } },
    });
    const reader = response.getReader();
    const frame = new TextDecoder().decode((await reader.read()).value);
    const data = frame.split("\ndata: ").at(1)?.trim();
    browser.run(receiveMessage, {
      input: { message: streamMessage.parse(JSON.parse(data ?? "")), version: client.version() },
    });
    await reader.cancel();
    await first.close({ graceful: true });
    accepted.resolve();
    const second = server.createSession({ tags: requestHeaders(ada) });
    const resumed = await second.run(openSync, {
      input: {
        cursor: {
          public: client.cursors().publicRevision,
          private: { accountId: initial.stream, revision: client.cursors().privateRevision },
        },
      },
    });
    const replay = resumed.getReader();
    let resultFrame = new TextDecoder().decode((await replay.read()).value);
    if (resultFrame.startsWith(":"))
      resultFrame = new TextDecoder().decode((await replay.read()).value);
    browser.run(receiveMessage, {
      input: {
        message: streamMessage.parse(JSON.parse(resultFrame.split("\ndata: ").at(1)?.trim() ?? "")),
        version: client.version(),
      },
    });
    expect(await waiting).toEqual({
      kind: "complete",
      action: "profile",
      profileId: initial.profile.id,
    });
    await replay.cancel();
    expect((await second.close({ graceful: true })).status).toBe("success");
  } finally {
    accepted.resolve();
    stop.abort();
    expect((await browser.closed).status).toBe("success");
    expect((await server.closed).status).toBe("success");
  }
});

test("a quiet private stream closes at the heartbeat after sign-out", async () => {
  const stop = new AbortController();
  const clock = makeTestClock();
  const root = createScope({
    signal: stop.signal,
    clock,
    tags: [settings, backendStop(stop.signal), requestStop(stop.signal)],
    presets: [proofDatabase, proofMail],
  });
  await root.ready;
  try {
    await root.run(migrate);
    await root.run(disableSessionWake);
    const ada = headers(
      await root.run(handleAuth, { input: signup("Ada"), tags: requestHeaders(new Headers()) }),
    );
    const snapshot = await root.run(bootstrapPrivate, { tags: requestHeaders(ada) });
    const owner = root.createSession({ tags: requestHeaders(ada) });
    const response = await owner.run(openSync, {
      input: {
        cursor: { public: 0, private: { accountId: snapshot.stream, revision: snapshot.revision } },
      },
    });
    const reader = response.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
    const waiting = reader.read();
    await root.run(handleAuth, {
      tags: requestHeaders(ada),
      input: new Request("http://localhost:4318/api/auth/sign-out", {
        method: "POST",
        headers: new Headers([...ada, ["origin", "http://localhost:4318"]]),
      }),
    });
    clock.advance(10_000);
    expect(new TextDecoder().decode((await waiting).value)).toBe(
      'event: account\ndata: {"kind":"account-change"}\n\n',
    );
    expect((await reader.read()).done).toBe(true);
    expect((await owner.close({ graceful: true })).status).toBe("success");
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});
