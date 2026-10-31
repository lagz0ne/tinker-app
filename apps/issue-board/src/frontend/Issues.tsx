import { Link, Navigate } from "@tanstack/react-router";
import { data, operation } from "@tinker/core";
import { useData, useRun } from "@tinker/react";

import { syncClient } from "~/components/sync";

import {
  issueChange,
  issueRecord,
  issueStates,
  issueStateLabels,
  issuePriorities,
} from "@/contracts/issues";
import type { Issue } from "@/contracts/issues";
import type { Errors } from "@/demo/errors";
import { issues, profile, teams } from "@/demo/frontend/state";
import { updateIssue } from "@/transport/issues.functions";

import { Comments } from "./Comments";
import { FailureAlert } from "./failures";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";

const pending = data({ label: "issues.pending", initial: false });
const editor = data<Issue | null>({ label: "issues.editor", initial: null });
const dragging = data<Issue | null>({ label: "issues.dragging", initial: null });

const openEditor = operation({
  label: "issues.openEditor",
  input: issueRecord.nullable(),
  depends: { editor: editor.controller },
  run: ({ editor }, { input }) => editor.set(input),
});

const dragIssue = operation({
  label: "issues.drag",
  input: issueRecord.nullable(),
  depends: { dragging: dragging.controller },
  run: ({ dragging }, { input }) => dragging.set(input),
});

const saveIssue = operation({
  label: "issues.save",
  input: issueChange,
  depends: { sync: syncClient, pending: pending.controller, editor: editor.controller },
  run: async ({ sync, pending, editor }, { input, random, signal, defer, raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    pending.set(true);
    defer(() => pending.set(false));

    const executionId = random.uuid();
    const result = await sync.execute(
      executionId,
      { send: updateIssue, data: { executionId, change: input } },
      signal,
    );
    if (result.kind === "failed") {
      return raise("BadInput", { reason: result.message });
    }
    editor.set(null);
  },
});

export function Issues({
  teamId,
  members,
}: {
  teamId: string;
  members: { id: string; name: string }[];
}) {
  const account = useData(profile);
  const allTeams = useData(teams);
  const rows = useData(issues)
    .filter((row) => row.teamId === teamId)
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1));
  const busy = useData(pending);
  const draft = useData(editor);
  const dragged = useData(dragging);
  const save = useRun(saveIssue);
  const edit = useRun(openEditor);
  const drag = useRun(dragIssue);
  const team = allTeams.find((row) => row.id === teamId);

  if (!account) return <Navigate to="/" />;
  if (!team) {
    return (
      <main className="p-5">
        <p>You are not on this team.</p>
        <Link to="/teams">Teams</Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-5 py-8">
      <header>
        <Link to="/teams">All teams</Link>
        <h1 className="mt-3 text-2xl font-semibold">{team.key} · Issue board</h1>
        <p>{team.name}</p>
        <p>Drag an issue to a column or before another issue. You can also use its Move menu.</p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>New issue</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            method="post"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              save.run({
                rawInput: {
                  kind: "create",
                  teamId,
                  title: form.get("title"),
                  description: form.get("description"),
                  state: form.get("state"),
                  priority: Number(form.get("priority")),
                  assigneeId: form.get("assigneeId") || null,
                },
              });
            }}
          >
            <IssueFields members={members} busy={busy} />
            <Button disabled={busy}>Create issue</Button>
          </form>
        </CardContent>
      </Card>
      <FailureAlert error={save.error} />
      {draft && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>
                Edit {draft.teamKey}-{draft.number}
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p>Editing version {draft.version}. If another member saves first, reopen this edit.</p>
            <form
              key={`${draft.id}:${draft.version}`}
              method="post"
              data-issue={`${draft.teamKey}-${draft.number}`}
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                save.run({
                  rawInput: {
                    kind: "edit",
                    id: draft.id,
                    version: draft.version,
                    teamId,
                    title: form.get("title"),
                    description: form.get("description"),
                    state: form.get("state"),
                    priority: Number(form.get("priority")),
                    assigneeId: form.get("assigneeId") || null,
                  },
                });
              }}
            >
              <IssueFields row={draft} members={members} busy={busy} />
              <Button disabled={busy}>{`Save ${draft.teamKey}-${draft.number}`}</Button>
              <Button type="button" disabled={busy} onClick={() => edit.run({ input: null })}>
                Close edit
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
      {rows.length === 0 && <p>No issues yet.</p>}
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
        {issueStates.map((state) => (
          <section
            key={state}
            data-state={state}
            className="min-h-44 rounded-lg border bg-slate-50 p-3"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (!dragged || busy) return;
              save.run({
                input: {
                  kind: "move",
                  teamId,
                  id: dragged.id,
                  version: dragged.version,
                  state,
                  beforeId: null,
                },
              });
              drag.run({ input: null });
            }}
          >
            <h2 className="mb-4 font-semibold">{issueStateLabels[state]}</h2>
            {rows
              .filter((row) => row.state === state)
              .map((row) => (
                <article
                  key={row.id}
                  data-card={`${row.teamKey}-${row.number}`}
                  data-version={row.version}
                  draggable={!busy}
                  className="mb-3 space-y-3 rounded-lg border bg-white p-3 shadow-sm"
                  onDragStart={(event) => {
                    if ((event.target as HTMLElement).closest("[data-comment-area]")) return;

                    event.dataTransfer.setData("text/plain", row.id);
                    drag.run({ input: row });
                  }}
                  onDragEnd={() => drag.run({ input: null })}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!dragged || dragged.id === row.id || busy) return;
                    save.run({
                      input: {
                        kind: "move",
                        teamId,
                        id: dragged.id,
                        version: dragged.version,
                        state,
                        beforeId: row.id,
                      },
                    });
                    drag.run({ input: null });
                  }}
                >
                  <h3 className="font-semibold">
                    {row.teamKey}-{row.number} · {row.title}
                  </h3>
                  <p data-testid={`issue-summary-${row.number}`}>
                    {row.teamKey}-{row.number} · {issueStateLabels[row.state]} · Priority{" "}
                    {row.priority} ·{" "}
                    {members.find((member) => member.id === row.assigneeId)?.name ?? "Unassigned"}
                  </p>
                  <Comments
                    issueId={row.id}
                    teamId={teamId}
                    label={`${row.teamKey}-${row.number}`}
                    members={members}
                  />
                  <label className="grid gap-1">
                    Move {row.teamKey}-{row.number}
                    <select
                      name="move"
                      className="min-h-11 rounded border p-2"
                      value={row.state}
                      disabled={busy}
                      onChange={(event) =>
                        save.run({
                          rawInput: {
                            kind: "move",
                            teamId,
                            id: row.id,
                            version: row.version,
                            state: event.currentTarget.value,
                            beforeId: null,
                          },
                        })
                      }
                    >
                      {issueStates.map((value) => (
                        <option key={value} value={value}>
                          {issueStateLabels[value]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button disabled={busy} onClick={() => edit.run({ input: row })}>
                    {`Edit ${row.teamKey}-${row.number}`}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      save.run({
                        input: { kind: "remove", teamId, id: row.id, version: row.version },
                      })
                    }
                  >
                    {`Remove ${row.teamKey}-${row.number}`}
                  </Button>
                </article>
              ))}
          </section>
        ))}
      </div>
    </main>
  );
}

function IssueFields({
  row = { title: "", description: "", state: "backlog", priority: 0, assigneeId: null },
  members,
  busy,
}: {
  row?: Pick<Issue, "title" | "description" | "state" | "priority" | "assigneeId">;
  members: { id: string; name: string }[];
  busy: boolean;
}) {
  return (
    <>
      <label className="grid gap-2">
        Issue title
        <Input name="title" required maxLength={200} defaultValue={row.title} disabled={busy} />
      </label>
      <label className="grid gap-2">
        Description
        <textarea
          className="rounded-md border p-3"
          name="description"
          maxLength={10000}
          defaultValue={row.description}
          disabled={busy}
        />
      </label>
      <label className="grid gap-2">
        State
        <select
          className="min-h-11 rounded-md border p-2"
          name="state"
          defaultValue={row.state}
          disabled={busy}
        >
          {issueStates.map((state) => (
            <option key={state} value={state}>
              {issueStateLabels[state]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-2">
        Priority
        <select
          className="min-h-11 rounded-md border p-2"
          name="priority"
          defaultValue={row.priority}
          disabled={busy}
        >
          {issuePriorities.map((name, priority) => (
            <option key={priority} value={priority}>
              {priority} · {name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-2">
        Assignee
        <select
          className="min-h-11 rounded-md border p-2"
          name="assigneeId"
          defaultValue={row.assigneeId ?? ""}
          disabled={busy}
        >
          <option value="">Unassigned</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
