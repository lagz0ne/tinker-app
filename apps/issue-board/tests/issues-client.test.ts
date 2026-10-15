import { createScope } from "@tinker/core";
import { test, expect } from "vite-plus/test";

import {
  syncStartup,
  tabStop,
  syncClient,
  applyBootstrap,
  applyEvents,
  leaveAccount,
} from "~/components/sync";
import type { Sync } from "~/components/sync";

import { issues } from "@/demo/frontend/state";

import { clientBindings } from "./presets";

test("saved issue events beat older snapshots and account exit clears the issues", async () => {
  const stop = new AbortController();
  const root = createScope({
    signal: stop.signal,
    extensions: [syncStartup],
    tags: [clientBindings, tabStop(stop.signal)],
  });
  await root.ready;

  try {
    const snapshot: Sync.Snapshot = {
      public: { stream: "public", revision: 0, value: 0 },
      private: {
        stream: "ada",
        revision: 0,
        profile: { id: "ada", name: "Ada", email: "ada@example.com", emailVerified: false },
        todos: [],
        teams: [],
        issues: [],
      },
    };
    root.run(applyBootstrap, { input: { snapshot, version: 0 } });
    const version = root.resolve(syncClient).capture().version;
    const issue = {
      id: crypto.randomUUID(),
      teamId: crypto.randomUUID(),
      teamKey: "ENG",
      number: 1,
      title: "Saved work",
      description: "",
      state: "in_progress" as const,
      priority: 1,
      assigneeId: "ada",
      creatorId: "ada",
      rank: "000000000001",
    };
    const saved: Sync.Event = {
      stream: "ada",
      revision: 1,
      executionId: crypto.randomUUID(),
      payload: { kind: "change", change: { kind: "issues", rows: [issue] } },
    };
    root.run(applyEvents, { input: { events: [saved], version } });
    expect(root.resolve(issues)).toEqual([issue]);

    root.run(applyBootstrap, { input: { snapshot, version } });
    expect(root.resolve(issues)).toEqual([issue]);
    root.run(leaveAccount);
    expect(root.resolve(issues)).toEqual([]);
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});
