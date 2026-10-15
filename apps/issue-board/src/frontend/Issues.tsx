import { Link, Navigate } from "@tanstack/react-router";
import { data, operation } from "@tinker/core";
import { useData, useRun } from "@tinker/react";

import { syncClient } from "~/components/sync";

import { issueChange, issueStates, issueStateLabels, issuePriorities } from "@/contracts/issues";
import { raise } from "@/demo/errors";
import { issues, profile, teams } from "@/demo/frontend/state";
import { updateIssue } from "@/transport/issues.functions";

import { errorText } from "./error-text";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";

const pending = data({ label: "issues.pending", initial: false });

const saveIssue = operation({
  label: "issues.save",
  input: issueChange,
  depends: { sync: syncClient, pending: pending.controller },
  run: async ({ sync, pending }, { input, random, signal, defer }) => {
    pending.set(true);
    defer(() => pending.set(false));

    const executionId = random.uuid();
    const result = await sync.execute(
      executionId,
      { send: updateIssue, data: { executionId, change: input } },
      signal,
    );
    if (result.kind === "failed") raise("BadInput", { reason: result.message });
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
  const rows = useData(issues).filter((row) => row.teamId === teamId);
  const busy = useData(pending);
  const save = useRun(saveIssue);
  const team = allTeams.find((row) => row.id === teamId);

  if (!account) return <Navigate to="/" />;
  if (!team) {
    return (
      <main className="mx-auto max-w-2xl p-5">
        <p>You are not on this team.</p>
        <Link to="/teams">Teams</Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-5 py-8">
      <header>
        <Link to="/teams">All teams</Link>
        <h1 className="mt-3 text-2xl font-semibold">{team.key} · Issues</h1>
        <p>{team.name}</p>
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
            <label className="grid gap-2">
              Issue title
              <Input name="title" required maxLength={200} disabled={busy} />
            </label>
            <label className="grid gap-2">
              Description
              <textarea
                className="rounded-md border p-3"
                name="description"
                maxLength={10000}
                disabled={busy}
              />
            </label>
            <label className="grid gap-2">
              State
              <select
                className="min-h-11 rounded-md border p-2"
                name="state"
                defaultValue="backlog"
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
                defaultValue="0"
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
              <select className="min-h-11 rounded-md border p-2" name="assigneeId" disabled={busy}>
                <option value="">Unassigned</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <Button disabled={busy}>Create issue</Button>
          </form>
        </CardContent>
      </Card>
      <p role="alert">{errorText(save.error)}</p>
      {rows.length === 0 && <p>No issues yet.</p>}
      {rows.map((row) => (
        <Card key={row.id}>
          <CardHeader>
            <CardTitle>
              <h2>
                {row.teamKey}-{row.number} · {row.title}
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4" data-testid={`issue-summary-${row.number}`}>
              {row.teamKey}-{row.number} · {issueStateLabels[row.state]} · Priority {row.priority} ·{" "}
              {members.find((member) => member.id === row.assigneeId)?.name ?? "Unassigned"}
            </p>
            <form
              method="post"
              data-issue={`${row.teamKey}-${row.number}`}
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                save.run({
                  rawInput: {
                    kind: "edit",
                    id: row.id,
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
              <label className="grid gap-2">
                Title for {row.teamKey}-{row.number}
                <Input
                  name="title"
                  required
                  maxLength={200}
                  defaultValue={row.title}
                  disabled={busy}
                />
              </label>
              <label className="grid gap-2">
                Description for {row.teamKey}-{row.number}
                <textarea
                  className="rounded-md border p-3"
                  name="description"
                  maxLength={10000}
                  defaultValue={row.description}
                  disabled={busy}
                />
              </label>
              <label className="grid gap-2">
                State for {row.teamKey}-{row.number}
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
                Priority for {row.teamKey}-{row.number}
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
                Assignee for {row.teamKey}-{row.number}
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
              <Button disabled={busy}>{`Save ${row.teamKey}-${row.number}`}</Button>
            </form>
          </CardContent>
        </Card>
      ))}
    </main>
  );
}
