import { Counter } from "./Counter.tsx";
import { Link, Navigate } from "@tanstack/react-router";
import { useData, useRun } from "@tinker/react";
import type { Profile } from "../contracts/profile.ts";
import { profile, nameDraft, pending, notice, authMode, profileResult } from "./state.ts";
import { signIn, signOut, saveName, setAuthMode, editName, retryMail } from "./actions.ts";
import { isError } from "../errors.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card.tsx";
function errorText(error: unknown) {
  if (isError(error, "AuthFailed")) return error.payload.message;
  if (isError(error, "WriteRejected")) return error.payload.message;
  if (isError(error, "BadInput")) return error.payload.reason;
  return error ? "That did not work. Try again." : "";
}
function AccountForm() {
  const mode = useData(authMode);
  const changeMode = useRun(setAuthMode);
  const action = useRun(signIn);
  const busy = useData(pending);
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        action.run({
          rawInput: {
            mode,
            name: form.get("name") ?? "",
            email: form.get("email"),
            password: form.get("password"),
          },
        });
      }}
    >
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        <Button
          type="button"
          variant={mode === "signup" ? "outline" : "ghost"}
          className="flex-1 text-xs"
          disabled={busy}
          aria-pressed={mode === "signup"}
          onClick={() => changeMode.run({ input: "signup" })}
        >
          Make an account
        </Button>
        <Button
          type="button"
          variant={mode === "signin" ? "outline" : "ghost"}
          className="flex-1 text-xs"
          disabled={busy}
          aria-pressed={mode === "signin"}
          onClick={() => changeMode.run({ input: "signin" })}
        >
          Sign in
        </Button>
      </div>
      {mode === "signup" && (
        <label className="grid gap-2 text-sm font-medium">
          Name
          <Input
            name="name"
            autoComplete="name"
            required
            maxLength={80}
            placeholder="Ada Lovelace"
            disabled={busy}
          />
        </label>
      )}
      <label className="grid gap-2 text-sm font-medium">
        Email
        <Input
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="ada@example.com"
          disabled={busy}
        />
      </label>
      <label className="grid gap-2 text-sm font-medium">
        Password
        <Input
          name="password"
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          minLength={8}
          required
          placeholder="At least 8 characters"
          disabled={busy}
        />
      </label>
      <Button className="w-full" disabled={busy}>
        {busy ? "Working…" : mode === "signup" ? "Make account" : "Sign in"}
      </Button>
      <p role="alert" className="text-sm text-destructive">
        {errorText(action.error)}
      </p>
    </form>
  );
}
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
export function App() {
  const current = useData(profile);
  const message = useData(notice);
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-5 py-8">
      <header>
        <p className="text-xs font-semibold tracking-widest text-muted-foreground">STARTER</p>
        <h1 className="mt-3 text-2xl font-semibold">A shared counter. Your private space.</h1>
      </header>
      <Counter />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{current ? "Your account" : "Sign in or make an account"}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {current ? (
            <div className="flex gap-3">
              <Button asChild>
                <Link to="/profile">Open profile</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/todos">Open private list</Link>
              </Button>
            </div>
          ) : (
            <AccountForm />
          )}
          <p role="status" className="mt-3 text-sm">
            {message}
          </p>
        </CardContent>
      </Card>
    </main>
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
