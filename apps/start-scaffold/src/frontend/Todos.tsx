import { z } from "zod";
import { data, operation, isError as isCoreError } from "@tinker/core";
import { useData, useRun } from "@tinker/react";
import { Link, Navigate, useRouterState } from "@tanstack/react-router";
import { updateTodo } from "../transport/todos.functions.ts";
import { readTodoChange } from "../contracts/todos.ts";
import { todos, profile } from "./state.ts";
import { syncClient } from "../scaffold/frontend/sync.ts";
import { isError } from "../errors.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card.tsx";
const flow = data<{ kind: "idle" } | { kind: "saving" } | { kind: "failed"; message: string }>({
  label: "todos.flow",
  initial: { kind: "idle" },
});
const saveTodo = operation({
  label: "todos.save",
  input: readTodoChange,
  depends: { flow: flow.controller, sync: syncClient },
  run: async ({ flow, sync }, ctx) => {
    flow.set({ kind: "saving" });
    ctx.defer(() => flow.set({ kind: "idle" }));
    const executionId = ctx.random.uuid();
    await sync.execute(
      executionId,
      { send: updateTodo, data: { executionId, change: ctx.input } },
      ctx.signal,
    );
  },
});
const showFailure = operation({
  label: "todos.showFailure",
  input(error: unknown) {
    const cause = isCoreError(error, "DataValidationFailed") ? error.payload.cause : error;
    return isError(cause, "BadInput")
      ? cause.payload.reason
      : "That change did not finish. Try again or reload the page.";
  },
  depends: { flow: flow.controller },
  run: ({ flow }, ctx) => {
    flow.set({
      kind: "failed",
      message: ctx.input,
    });
  },
});
const attemptTodo = operation({
  label: "todos.attempt",
  input: z.unknown(),
  depends: { save: saveTodo, failure: showFailure },
  run: async ({ save, failure }, ctx) => {
    const result = await save.settle({ rawInput: ctx.input });
    if (result.status === "success") return true;
    if (result.status === "failed") failure.run({ rawInput: result.error });
    else failure.run({ rawInput: undefined });
    return false;
  },
});
export function Todos() {
  const rows = useData(todos);
  const account = useData(profile);
  const loading = useRouterState({ select: (state) => state.isLoading });
  const state = useData(flow);
  const save = useRun(attemptTodo);
  const busy = state.kind === "saving" || loading;
  if (account === null) return <Navigate to="/" />;
  return (
    <main className="mx-auto max-w-2xl px-5 py-8 sm:py-12">
      <header className="mb-8 flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-widest text-muted-foreground">
            TINKERED / TODOS
          </p>
          <p className="mt-2 break-all text-sm text-muted-foreground">
            {account.name} · {account.email}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/profile" disabled={busy}>
            Account
          </Link>
        </Button>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>Your private list</h1>
          </CardTitle>
          <CardDescription>Only you can read or change these todos.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="mb-5 flex items-end gap-2"
            onSubmit={async (event) => {
              event.preventDefault();
              const form = event.currentTarget;
              if (
                await save.runAsync({
                  rawInput: { kind: "add", title: new FormData(form).get("title") },
                })
              )
                form.reset();
            }}
          >
            <label className="grid min-w-0 flex-1 gap-2 text-sm font-medium">
              New todo
              <Input
                name="title"
                placeholder="What needs doing?"
                required
                maxLength={200}
                disabled={busy}
              />
            </label>
            <Button disabled={busy}>Add todo</Button>
          </form>
          <p role="alert" className="mb-3 text-sm text-destructive">
            {state.kind === "failed" ? state.message : null}
          </p>
          {rows.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              Your list is empty. Add your first todo.
            </p>
          ) : (
            <ul className="divide-y">
              {rows.map((row) => (
                <li key={row.id} className="flex items-center gap-3 py-3">
                  <label className="flex min-w-0 flex-1 items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={row.done}
                      disabled={busy}
                      onChange={(event) =>
                        save.runAsync({
                          rawInput: { kind: "setDone", id: row.id, done: event.target.checked },
                        })
                      }
                      className="size-4 shrink-0 accent-primary"
                    />
                    <span
                      className={
                        row.done
                          ? "min-w-0 break-words text-muted-foreground line-through"
                          : "min-w-0 break-words"
                      }
                    >
                      {row.title}
                    </span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Delete ${row.title}`}
                    onClick={() => save.runAsync({ rawInput: { kind: "delete", id: row.id } })}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-5 text-xs text-muted-foreground">
            {rows.filter((row) => row.done).length} of {rows.length} done. Changes are saved in your
            account.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
