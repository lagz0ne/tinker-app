import { Link } from "@tanstack/react-router";
import { useData, useRun } from "@tinker/react";

import { profile, pending, notice, authMode } from "@/demo/frontend/state";

import { signIn, setAuthMode, signOut } from "./auth-actions";
import { errorText } from "./error-text";
import { Button } from "./ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Input } from "./ui/input";

function AccountForm() {
  const mode = useData(authMode);
  const changeMode = useRun(setAuthMode);
  const action = useRun(signIn);
  const busy = useData(pending);
  return (
    <form
      method="post"
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

export function App() {
  const current = useData(profile);
  const message = useData(notice);
  const exit = useRun(signOut);
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-5 py-8">
      <header>
        <p className="text-xs font-semibold tracking-widest text-muted-foreground">ISSUE BOARD</p>
        <h1 className="mt-3 text-2xl font-semibold">A home for your team.</h1>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{current ? "Your account" : "Sign in or make an account"}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {current ? (
            <div className="space-y-6">
              <p>Signed in as {current.email}</p>
              <Button variant="outline" onClick={() => exit.run()}>
                Sign out
              </Button>
              <Button asChild>
                <Link to="/teams">Open teams</Link>
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
