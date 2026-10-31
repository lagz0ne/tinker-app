import { data, operation } from "@tinker/core";
import { useData, useRun } from "@tinker/react";
import { z } from "zod";

import { syncClient } from "~/components/sync";

import { commentDraft } from "@/contracts/comments";
import type { Errors } from "@/demo/errors";
import { comments, commentDrafts } from "@/demo/frontend/state";
import { postComment } from "@/transport/comments.functions";

import { FailureAlert } from "./failures";
import { Button } from "./ui/button";

const pending = data({ label: "comments.pending", initial: false });

const editDraft = operation({
  label: "comments.editDraft",
  input: z.object({ issueId: z.uuid(), body: z.string().max(5000) }),
  depends: { drafts: commentDrafts.controller },
  run: ({ drafts }, { input }) => drafts.set({ ...drafts.get(), [input.issueId]: input.body }),
});

const submitComment = operation({
  label: "comments.submit",
  input: commentDraft,
  depends: { sync: syncClient, pending: pending.controller, drafts: commentDrafts.controller },
  run: async ({ sync, pending, drafts }, { input, random, signal, defer, raise }) => {
    pending.set(true);
    defer(() => pending.set(false));

    const executionId = random.uuid();
    const result = await sync.execute(
      executionId,
      { send: postComment, data: { executionId, comment: input } },
      signal,
    );
    if (result.kind === "failed") {
      return raise("BadInput", { reason: result.message } satisfies Errors.Payload<"BadInput">);
    }
    drafts.set({ ...drafts.get(), [input.issueId]: "" });
  },
});

export function Comments({
  issueId,
  teamId,
  label,
  members,
}: {
  issueId: string;
  teamId: string;
  label: string;
  members: { id: string; name: string }[];
}) {
  const rows = useData(comments)
    .filter((row) => row.issueId === issueId)
    .sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
    );
  const drafts = useData(commentDrafts);
  const busy = useData(pending);
  const edit = useRun(editDraft);
  const submit = useRun(submitComment);

  return (
    <section
      data-comment-area
      aria-label={`Comments on ${label}`}
      className="space-y-3 border-t pt-3"
    >
      <h4 className="font-semibold">Comments</h4>
      <ol data-comments={label} className="space-y-3">
        {rows.map((row) => (
          <li key={row.id} data-comment={row.id} className="rounded border p-2">
            <p className="text-sm">
              {members.find((member) => member.id === row.authorId)?.name ?? "Team member"} ·{" "}
              <time dateTime={row.createdAt}>{row.createdAt}</time>
            </p>
            <p className="whitespace-pre-wrap break-words">{row.body}</p>
          </li>
        ))}
      </ol>
      <form
        method="post"
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit.run({ rawInput: { issueId, teamId, body: drafts[issueId] ?? "" } });
        }}
      >
        <label className="grid gap-1">
          {`Comment on ${label}`}
          <textarea
            name="comment"
            required
            maxLength={5000}
            disabled={busy}
            className="rounded border p-2"
            value={drafts[issueId] ?? ""}
            onChange={(event) => edit.run({ input: { issueId, body: event.currentTarget.value } })}
          />
        </label>
        <Button disabled={busy}>{`Add comment to ${label}`}</Button>
      </form>
      <FailureAlert error={submit.error} />
    </section>
  );
}
