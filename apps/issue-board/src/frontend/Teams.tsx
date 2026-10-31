import { Link, Navigate } from "@tanstack/react-router";
import { data, operation } from "@tinker/core";
import { useData, useRun } from "@tinker/react";

import { syncClient } from "~/components/sync";

import { teamChange } from "@/contracts/board";
import type { Errors } from "@/demo/errors";
import { profile, teams } from "@/demo/frontend/state";
import { updateTeam } from "@/transport/teams.functions";

import { signOut } from "./auth-actions";
import { errorText } from "./error-text";
import { Button } from "./ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Input } from "./ui/input";

const pending = data({ label: "teams.pending", initial: false });

const saveTeam = operation({
  label: "teams.save",
  input: teamChange,
  depends: { sync: syncClient, pending: pending.controller },
  run: async ({ sync, pending }, { input, random, signal, defer, raise }) => {
    pending.set(true);
    defer(() => pending.set(false));

    const executionId = random.uuid();
    const result = await sync.execute(
      executionId,
      { send: updateTeam, data: { executionId, change: input } },
      signal,
    );

    if (result.kind === "failed") {
      return raise("BadInput", { reason: result.message } satisfies Errors.Payload<"BadInput">);
    }
  },
});

export function Teams() {
  const account = useData(profile);
  const rows = useData(teams);
  const busy = useData(pending);
  const save = useRun(saveTeam);
  const exit = useRun(signOut);

  if (!account) return <Navigate to="/" />;

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-5 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-widest text-muted-foreground">ISSUE BOARD</p>
          <h1 className="mt-2 text-2xl font-semibold">Your teams</h1>
          <p className="mt-2 break-all text-sm">
            {account.name} · {account.email}
          </p>
        </div>
        <Button variant="outline" onClick={() => exit.run()} disabled={busy}>
          Sign out
        </Button>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Make a team</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              save.run({
                rawInput: { kind: "create", key: form.get("key"), name: form.get("name") },
              });
            }}
          >
            <label className="grid gap-2">
              Team key
              <Input
                name="key"
                placeholder="ENG"
                required
                pattern="[A-Za-z][A-Za-z0-9]{1,9}"
                maxLength={10}
                disabled={busy}
              />
            </label>
            <label className="grid gap-2">
              Team name
              <Input
                name="name"
                placeholder="Engineering"
                required
                maxLength={100}
                disabled={busy}
              />
            </label>
            <Button disabled={busy}>Make team</Button>
          </form>
        </CardContent>
      </Card>
      <p role="alert">{errorText(save.error) || errorText(exit.error)}</p>
      {rows.length === 0 && <p>No teams yet. Make your first team.</p>}
      {rows.map((row) => (
        <Card key={row.id}>
          <CardHeader>
            <CardTitle>
              <h2>
                {row.key} · {row.name}
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4">Your role: {row.role}</p>
            <Button asChild className="mb-4">
              <Link to="/issues/$teamId" params={{ teamId: row.id }}>
                Open {row.key} issues
              </Link>
            </Button>
            {row.role === "admin" && (
              <form
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  save.run({
                    rawInput: {
                      kind: "addMember",
                      teamId: row.id,
                      email: new FormData(event.currentTarget).get("email"),
                    },
                  });
                }}
              >
                <label className="grid gap-2">
                  Member email
                  <Input
                    type="email"
                    name="email"
                    required
                    placeholder="teammate@example.com"
                    disabled={busy}
                  />
                </label>
                <Button disabled={busy}>Add member</Button>
                <p className="text-sm text-muted-foreground">They must have an account first.</p>
              </form>
            )}
          </CardContent>
        </Card>
      ))}
      <Link to="/">Home</Link>
    </main>
  );
}
