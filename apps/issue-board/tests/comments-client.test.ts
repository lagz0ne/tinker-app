import { createScope, operation } from "@tinker/core";
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

import { comments, commentDrafts } from "@/demo/frontend/state";

import { clientBindings } from "./presets";

test("comment events are idempotent, beat older snapshots, and clear on issue removal or account exit", async () => {
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
        issues: [],
        comments: [],
      },
    };
    root.run(applyBootstrap, { input: { snapshot, version: 0 } });
    const version = root.resolve(syncClient).capture().version;
    const comment = {
      id: crypto.randomUUID(),
      issueId: crypto.randomUUID(),
      authorId: "ada",
      body: "Live note",
      createdAt: "2026-10-16T00:00:00.000Z",
    };
    const saved: Sync.Event = {
      stream: "ada",
      revision: 1,
      executionId: crypto.randomUUID(),
      payload: { kind: "change", change: { kind: "comment.add", comment } },
    };
    root.run(applyEvents, {
      input: {
        version,
        events: [
          saved,
          {
            ...saved,
            revision: 2,
            payload: {
              kind: "change",
              change: {
                kind: "comment.add",
                comment: { ...comment, body: "Cannot rewrite a saved comment" },
              },
            },
          },
        ],
      },
    });
    expect(root.resolve(comments)).toEqual([comment]);
    root.run(applyBootstrap, { input: { snapshot, version } });
    expect(root.resolve(comments)).toEqual([comment]);

    root.run(applyEvents, {
      input: {
        version,
        events: [
          {
            ...saved,
            revision: 3,
            payload: { kind: "change", change: { kind: "issue.remove", id: comment.issueId } },
          },
        ],
      },
    });
    expect(root.resolve(comments)).toEqual([]);
    root.run(applyEvents, { input: { version, events: [{ ...saved, revision: 4 }] } });
    root.run(
      operation({
        label: "proof.commentDraft",
        depends: { drafts: commentDrafts.controller },
        run: ({ drafts }) => drafts.set({ [comment.issueId]: "Private draft" }),
      }),
    );
    root.run(leaveAccount);
    expect(root.resolve(comments)).toEqual([]);
    expect(root.resolve(commentDrafts)).toEqual({});
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});
