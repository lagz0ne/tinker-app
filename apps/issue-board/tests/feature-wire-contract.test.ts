import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { saveProfile } from "@/demo/backend/profile.server";
import { changeTodo } from "@/demo/backend/todos.server";
import { readProfileCommand, readTodoCommand } from "@/demo/contracts/commands";
import { credentials } from "@/demo/contracts/credentials";
import { profileRefusal, readProfileInput } from "@/demo/contracts/profile-contract";
import { readFeatureEvents, readFeatureResult, readSnapshot } from "@/demo/contracts/sync";
import { readTodoChange, todoRefusal } from "@/demo/contracts/todos-contract";
import { records } from "@/demo/frontend/records";
import { counter, nameDraft, profile, profileResult, todos } from "@/demo/frontend/state";

test("credentials accept both modes and their name/password limits", () => {
  for (const mode of ["signup", "signin"]) {
    const value = { mode, name: "n".repeat(80), email: "a@example.test", password: "p".repeat(9) };

    expect(credentials.parse(value)).toEqual(value);
    expect(credentials.safeParse({ ...value, name: "n".repeat(81) }).success).toBe(false);
    expect(credentials.safeParse({ ...value, password: "p".repeat(7) }).success).toBe(false);
    expect(credentials.safeParse({ ...value, mode: "other" }).success).toBe(false);
    expect(credentials.safeParse({ ...value, email: "not-an-email" }).success).toBe(false);
  }
});

test("profile input trims names, rejects extra keys and names the exact refusal", () => {
  expect(readProfileInput.parse({ name: " Ada " })).toEqual({ name: "Ada" });

  expect(readProfileInput.parse({ name: "n".repeat(80) })).toEqual({ name: "n".repeat(80) });
  for (const input of [
    {},
    { name: "" },
    { name: "   " },
    { name: "n".repeat(81) },
    { name: "Ada", extra: true },
  ]) {
    expect(readProfileInput.safeParse(input).success).toBe(false);
  }
  expect(profileRefusal).toBe("Use a name with 1 to 80 letters.");
  expect(todoRefusal).toBe("Use a title with 1 to 200 characters and a valid todo change.");
});

test("the command schemas keep one execution ID and hand the body to its own contract", () => {
  const executionId = "00000000-0000-4000-8000-000000000001";

  expect(readProfileCommand.parse({ executionId, profile: { name: " Ada " } })).toEqual({
    executionId,
    profile: { name: " Ada " },
  });
  expect(readTodoCommand.parse({ executionId, change: { kind: "add", title: " Task " } })).toEqual({
    executionId,
    change: { kind: "add", title: " Task " },
  });
  expect(readTodoChange.parse({ kind: "add", title: " Task " })).toEqual({
    kind: "add",
    title: "Task",
  });
});

test("saveProfile and changeTodo refuse a bad execution ID and an extra key at the input door", async () => {
  const root = createScope();
  const executionId = "00000000-0000-4000-8000-000000000001";

  try {
    for (const shape of [
      {
        rawInput: { executionId, profile: { name: "Ada" }, extra: 1 },
        issue: { code: "unrecognized_keys", keys: ["extra"] },
      },
      {
        rawInput: { executionId: "bad", profile: { name: "Ada" } },
        issue: { code: "invalid_format", path: ["executionId"] },
      },
    ]) {
      const refused = await root.settle(saveProfile, { rawInput: shape.rawInput });
      if (refused.status !== "failed") return expect.unreachable("expected a shape refusal");

      expect(refused.error).toMatchObject({
        kind: "DataValidationFailed",
        payload: {
          label: "saveProfile",
          cause: {
            kind: "SchemaRejected",
            payload: { issues: [expect.objectContaining(shape.issue)] },
          },
        },
      });
    }

    const todo = await root.settle(changeTodo, {
      rawInput: { executionId, change: { kind: "add", title: "Fine" }, extra: 1 },
    });
    if (todo.status !== "failed") return expect.unreachable("expected a shape refusal");

    expect(todo.error).toMatchObject({
      kind: "DataValidationFailed",
      payload: {
        label: "changeTodo",
        cause: {
          kind: "SchemaRejected",
          payload: { issues: [expect.objectContaining({ code: "unrecognized_keys" })] },
        },
      },
    });
  } finally {
    await root.close();
  }
});

test("feature events preserve each change and result variant", () => {
  const person = { id: "ada", name: "Ada", email: "ada@example.test", emailVerified: true };
  const row = { id: 1, title: "Task", done: false };
  const changes = [
    { kind: "counter", value: 3 },
    { kind: "profile", profile: person },
    { kind: "todos", rows: [row] },
  ];
  const events = changes.map((change, index) => ({
    stream: "public",
    revision: index + 1,
    executionId: "00000000-0000-4000-8000-000000000001",
    payload: { kind: "change", change },
  }));

  expect(readFeatureEvents.parse(events)).toEqual(events);
  for (const action of ["counter", "todo", "profile"]) {
    const result = { kind: "failed", action, message: "refused" };
    expect(readFeatureResult.parse(result)).toEqual(result);
    const event = { ...events[0], payload: { kind: "result", result } };
    expect(readFeatureEvents.parse([event])).toEqual([event]);
  }
  for (const action of ["counter", "todo"]) {
    expect(readFeatureResult.parse({ kind: "complete", action })).toEqual({
      kind: "complete",
      action,
    });
  }
  const snapshot = {
    public: { stream: "public", revision: 0, value: 2 },
    private: { stream: "ada", revision: 0, profile: person, todos: [row] },
  };
  expect(readSnapshot.parse(snapshot)).toEqual(snapshot);
  expect(
    readSnapshot.safeParse({ ...snapshot, public: { ...snapshot.public, value: "bad" } }).success,
  ).toBe(false);
  expect(
    readSnapshot.safeParse({
      ...snapshot,
      private: { ...snapshot.private, profile: { ...person, id: 1 } },
    }).success,
  ).toBe(false);
  expect(
    readFeatureResult.safeParse({ kind: "failed", action: "other", message: "refused" }).success,
  ).toBe(false);
  expect(
    readFeatureEvents.safeParse([
      {
        ...events[0],
        payload: { kind: "change", change: { kind: "todos", rows: [{ id: "bad" }] } },
      },
    ]).success,
  ).toBe(false);
});

test("record publisher accepts equal cursors, ignores older snapshots, and clears all private state", async () => {
  const root = createScope();
  const person = { id: "ada", name: "Ada", email: "ada@example.test", emailVerified: false };
  const row = { id: 1, title: "Task", done: false };
  try {
    const publisher = root.resolve(records);
    const count = root.controller(counter);
    const saved = root.controller(profile);
    const tasks = root.controller(todos);
    const draft = root.controller(nameDraft);
    const result = root.controller(profileResult);
    count.set(7);
    publisher.bootstrapPublic({ stream: "public", revision: 4, value: 2 }, 5);

    expect(count.get()).toBe(7);
    publisher.bootstrapPublic({ stream: "public", revision: 5, value: 3 }, 5);
    expect(count.get()).toBe(3);
    publisher.bootstrapPublic({ stream: "public", revision: 6, value: 4 }, 5);
    expect(count.get()).toBe(4);
    publisher.bootstrapPrivate({ stream: "ada", revision: 5, profile: person, todos: [row] }, 5);
    expect(saved.get()).toEqual(person);
    expect(tasks.get()).toEqual([row]);
    publisher.bootstrapPrivate(
      { stream: "ada", revision: 4, profile: { ...person, name: "stale" }, todos: [] },
      5,
    );
    expect(saved.get()).toEqual(person);
    expect(tasks.get()).toEqual([row]);
    publisher.change({ kind: "counter", value: 9 });
    publisher.change({ kind: "profile", profile: { ...person, name: "Updated" } });
    publisher.change({ kind: "todos", rows: [{ ...row, done: true }] });
    expect(publisher.snapshot(10, 11)).toEqual({
      public: { stream: "public", revision: 10, value: 9 },
      private: {
        stream: "ada",
        revision: 11,
        profile: { ...person, name: "Updated" },
        todos: [{ ...row, done: true }],
        teams: [],
        issues: [],
        comments: [],
      },
    });
    expect(publisher.snapshot(-1, -1)).toMatchObject({
      public: { revision: 0 },
      private: { revision: 0 },
    });
    draft.set("Unsaved");
    result.set({
      executionId: "one",
      result: { kind: "complete", action: "profile", profileId: "ada" },
    });
    publisher.resetPrivate();
    expect(saved.get()).toBeNull();
    expect(tasks.get()).toEqual([]);
    expect(draft.get()).toBeUndefined();
    expect(result.get()).toBeNull();
    expect(publisher.snapshot(10, 11)).toEqual({
      public: { stream: "public", revision: 10, value: 9 },
      private: null,
    });
  } finally {
    await root.close();
  }
});
