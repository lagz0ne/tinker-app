import { profile, counter, nameDraft } from "@tinker-start-scaffold/frontend";
import { test, expect } from "vite-plus/test";
import { createScope, operation } from "@tinker/core";
import { syncClient, applyBootstrap, applyEvents, leaveAccount } from "@tinker/start/client";
import { accountOwner, tabStop } from "@tinker/start/testing";
import type { Sync } from "@tinker/start";

const ada = { id: "ada", name: "Ada", email: "ada@example.com", emailVerified: false };

const initial: Sync.Snapshot = {
  public: { stream: "public", revision: 0, value: 0 },
  private: {
    stream: "ada",
    revision: 0,
    profile: { id: "ada", name: "Ada", email: "ada@example.com", emailVerified: false },
    todos: [],
  },
};

test("an event before its receipt finishes only after saved records are applied", async () => {
  const stop = new AbortController();
  const call = new AbortController();
  const receipt = Promise.withResolvers<Sync.Reply>();
  const sent = Promise.withResolvers<void>();
  const executionId = crypto.randomUUID();
  const send = operation({
    label: "test.sync.send",
    depends: { sync: syncClient },
    run: async ({ sync }, { signal }) =>
      sync.execute(
        executionId,
        {
          data: undefined,
          send: () => {
            sent.resolve();
            return receipt.promise;
          },
        },
        signal,
      ),
  });
  const root = createScope({
    signal: stop.signal,
    extensions: [accountOwner],
    tags: tabStop(stop.signal),
  });
  await root.ready;
  try {
    await root.run(applyBootstrap, { input: { snapshot: initial, version: 0 } });
    const client = await root.resolve(syncClient);
    const waiting = root.run(send, { signal: call.signal });
    await sent.promise;
    await root.run(applyEvents, {
      input: {
        version: client.capture().version,
        events: [
          {
            stream: "public",
            revision: 1,
            executionId,
            payload: { kind: "change", change: { kind: "counter", value: 1 } },
          },
          {
            stream: "public",
            revision: 2,
            executionId,
            payload: { kind: "result", result: { kind: "complete", action: "counter" } },
          },
        ],
      },
      signal: call.signal,
    });
    expect(root.resolve(counter)).toBe(1);
    receipt.resolve({ kind: "accepted", executionId });
    expect(await waiting).toEqual({ kind: "complete", action: "counter" });
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("replayed events and older snapshots leave newer records and dirty drafts alone", async () => {
  const stop = new AbortController();
  const root = createScope({
    signal: stop.signal,
    extensions: [accountOwner],
    tags: tabStop(stop.signal),
  });
  await root.ready;
  try {
    await root.run(applyBootstrap, { input: { snapshot: initial, version: 0 } });
    const client = await root.resolve(syncClient);
    const version = client.capture().version;
    root.controller(nameDraft).set("My unsaved text");
    const first: Sync.Event = {
      stream: "ada",
      revision: 1,
      executionId: crypto.randomUUID(),
      payload: {
        kind: "change",
        change: { kind: "profile", profile: { ...ada, name: "Remote first" } },
      },
    };
    const second: Sync.Event = {
      stream: "ada",
      revision: 2,
      executionId: crypto.randomUUID(),
      payload: {
        kind: "change",
        change: { kind: "profile", profile: { ...ada, name: "Remote latest" } },
      },
    };
    await root.run(applyEvents, { input: { version, events: [first, second] } });
    await root.run(applyEvents, { input: { version, events: [first, second] } });
    await root.run(applyBootstrap, { input: { version, snapshot: initial } });
    expect(root.resolve(profile)?.name).toBe("Remote latest");
    expect(root.resolve(nameDraft)).toBe("My unsaved text");
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("account exit stops local waits and ignores an old account's late response", async () => {
  const stop = new AbortController();
  const sent = Promise.withResolvers<void>();
  const executionId = crypto.randomUUID();
  const send = operation({
    label: "test.sync.send",
    depends: { sync: syncClient },
    run: async ({ sync }, { signal }) =>
      sync.execute(
        executionId,
        {
          data: undefined,
          send: async () => {
            sent.resolve();
            return { kind: "accepted", executionId };
          },
        },
        signal,
      ),
  });
  const root = createScope({
    signal: stop.signal,
    extensions: [accountOwner],
    tags: tabStop(stop.signal),
  });
  await root.ready;
  try {
    await root.run(applyBootstrap, { input: { snapshot: initial, version: 0 } });
    const client = await root.resolve(syncClient);
    const oldVersion = client.capture().version;
    const waiting = root.settle(send);
    await sent.promise;
    await root.run(leaveAccount);
    expect((await waiting).status).toBe("failed");
    const grace = {
      public: initial.public,
      private: {
        stream: "grace",
        revision: 0,
        profile: { id: "grace", name: "Grace", email: "grace@example.com", emailVerified: false },
        todos: [],
      },
    };
    await root.run(applyBootstrap, {
      input: { snapshot: grace, version: client.capture().version },
    });
    await root.run(applyBootstrap, { input: { snapshot: initial, version: oldVersion } });
    await root.run(applyEvents, {
      input: {
        version: oldVersion,
        events: [
          {
            stream: "ada",
            revision: 1,
            executionId,
            payload: {
              kind: "change",
              change: {
                kind: "profile",
                profile: { ...grace.private.profile, id: "ada", name: "Late Ada" },
              },
            },
          },
        ],
      },
    });
    expect(root.resolve(profile)?.id).toBe("grace");
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});
