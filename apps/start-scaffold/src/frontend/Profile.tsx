import { Link, Navigate } from "@tanstack/react-router";
import { useData, useRun } from "@tinker/react";
import type { Profile } from "../contracts/profile";
import { profile, nameDraft, pending, notice, profileResult } from "./state";
import { signOut } from "./auth-actions";
import { saveName, editName, retryMail } from "./profile-actions";
import { errorText } from "./error-text";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card";

function ProfileForm({ value }: { value: Profile.Value }) {
  const draft = useData(nameDraft);
  const last = useData(profileResult);
  const retry = useRun(retryMail);
  const changeName = useRun(editName);
  const save = useRun(saveName);
  const leave = useRun(signOut);
  const busy = useData(pending);
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        save.run({ rawInput: { name: draft ?? value.name } });
      }}
    >
      <div className="flex min-w-0 items-center gap-3 rounded-lg bg-muted p-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent font-semibold">
          {value.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0">
          <strong className="block truncate text-sm">{value.name}</strong>
          <small className="block truncate text-muted-foreground">{value.email}</small>
        </div>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">Signed in</span>
      </div>
      <label className="grid gap-2 text-sm font-medium">
        Name
        <Input
          value={draft ?? value.name}
          disabled={busy}
          onChange={(event) => changeName.run({ input: event.target.value })}
          required
          maxLength={80}
        />
      </label>
      <div className="flex gap-2">
        <Button disabled={busy}>{save.status === "pending" ? "Saving…" : "Save name"}</Button>
        <Button
          type="button"
          variant="outline"
          disabled={leave.status === "pending"}
          onClick={() => leave.run()}
        >
          {leave.status === "pending" ? "Signing out…" : "Sign out"}
        </Button>
      </div>
      {last?.result.kind === "partial" && (
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => retry.run({ input: last.executionId })}
        >
          Retry notification
        </Button>
      )}
      <Button asChild variant="secondary">
        <Link to="/todos" disabled={busy}>
          Open my todos
        </Link>
      </Button>
      <p role="alert" className="text-sm text-destructive">
        {errorText(save.error || leave.error)}
      </p>
    </form>
  );
}

export function ProfilePage() {
  const current = useData(profile);
  const message = useData(notice);
  if (current === null) return <Navigate to="/" />;
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-5 py-8">
      <Link to="/" className="text-sm underline">
        Shared counter
      </Link>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>Your profile</h1>
          </CardTitle>
          <CardDescription>
            Your saved name is shared with your private list. Unsaved text stays in this editor.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm value={current} />
          <p role="status" className="mt-3 text-sm">
            {message}
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
