import { resource } from "@tinker/core";

import type { Sync } from "~/components/sync";

import {
  profile,
  todos,
  counter,
  nameDraft,
  profileResult,
  teams,
  issues,
  comments,
  commentDrafts,
} from "./state";

/** Saved records have one publisher; drafts belong to the local editor. */
export const records = resource({
  label: "records",
  depends: {
    comments: comments.controller,
    commentDrafts: commentDrafts.controller,
    teams: teams.controller,
    issues: issues.controller,
    profile: profile.controller,
    todos: todos.controller,
    counter: counter.controller,
    draft: nameDraft.controller,
    result: profileResult.controller,
  },
  factory: ({
    profile,
    todos,
    counter,
    draft,
    result,
    teams,
    issues,
    comments,
    commentDrafts,
  }): Sync.Records => ({
    resetPrivate() {
      profile.set(null);
      todos.set([]);
      teams.set([]);
      issues.set([]);
      comments.set([]);
      commentDrafts.set({});

      draft.set(undefined);
      result.set(null);
    },
    bootstrapPublic(value: Sync.Snapshot["public"], after: number) {
      if (value.revision >= after) counter.set(value.value);
    },
    bootstrapPrivate(value: NonNullable<Sync.Snapshot["private"]>, after: number) {
      if (value.revision < after) return;

      profile.set(value.profile);
      todos.set(value.todos);
      teams.set(value.teams ?? []);
      issues.set(value.issues ?? []);
      comments.set(value.comments ?? []);
    },
    change(change: Sync.Change) {
      switch (change.kind) {
        case "comment.add":
          comments.update((rows) =>
            rows.some((row) => row.id === change.comment.id) ? rows : [...rows, change.comment],
          );
          break;
        case "issue.upsert":
          issues.set([...issues.get().filter((row) => row.id !== change.issue.id), change.issue]);
          break;
        case "issue.remove":
          issues.set(issues.get().filter((row) => row.id !== change.id));
          comments.set(comments.get().filter((row) => row.issueId !== change.id));
          break;
        case "teams":
          teams.set(change.rows);
          break;
        case "counter":
          counter.set(change.value);
          break;
        case "profile":
          profile.set(change.profile);
          break;
        case "todos":
          todos.set(change.rows);
          break;
      }
    },
    snapshot(publicRevision: number, privateRevision: number): Sync.Snapshot {
      const saved = profile.get();
      return {
        public: { stream: "public", revision: Math.max(0, publicRevision), value: counter.get() },
        private:
          saved === null
            ? null
            : {
                stream: saved.id,
                revision: Math.max(0, privateRevision),
                profile: saved,
                todos: todos.get(),
                teams: teams.get(),
                issues: issues.get(),
                comments: comments.get(),
              },
      };
    },
  }),
});
