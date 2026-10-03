import { operation, resource } from "@tinker/core";
import { z } from "zod";
import {
  updateProfile,
  getBackendSpans,
  retryProfileNotification,
} from "../transport/profile.functions.ts";
import {
  nameDraft,
  pending,
  notice,
  toolRows,
  frontendSpans,
  authMode,
  profileResult,
} from "./state.ts";
import { syncClient } from "../scaffold/frontend/sync.ts";
import { loadSnapshot, snapshotLoader } from "../scaffold/frontend/events.ts";
import { readCredentials } from "../contracts/credentials.ts";
import { readProfileInput } from "../contracts/profile.ts";
import { raise } from "../errors.ts";
const notificationId = z.uuid();
const modeInput = z.enum(["signup", "signin"]);
const draftInput = z.string();
export const authClient = resource({
  label: "browser.auth",
  factory: async () => {
    const { createAuthClient } = await import("better-auth/react");
    return createAuthClient();
  },
});
export const signIn = operation({
  label: "signIn",
  input: readCredentials,
  depends: {
    client: authClient,
    sync: syncClient,
    load: loadSnapshot,
    snapshots: snapshotLoader,
    pending: pending.controller,
    notice: notice.controller,
  },
  run: async ({ client, sync, load, snapshots, pending, notice }, ctx) => {
    pending.set(true);
    notice.set("");
    ctx.defer(() => pending.set(false));
    const finish = snapshots.beginAccountChange();
    ctx.defer(finish);
    sync.leave();
    const result =
      ctx.input.mode === "signup"
        ? await client.signUp.email(ctx.input, { signal: ctx.signal })
        : await client.signIn.email(ctx.input, { signal: ctx.signal });
    if (result.error) raise("AuthFailed", { message: result.error.message ?? "Sign in failed." });
    finish();
    await load.run();
    notice.set("You are signed in. Open your profile or private list.");
    ctx.log("account.signedIn");
  },
});
export const saveName = operation({
  label: "saveName",
  input: readProfileInput,
  depends: {
    sync: syncClient,
    draft: nameDraft.controller,
    pending: pending.controller,
    notice: notice.controller,
    result: profileResult.controller,
  },
  run: async ({ sync, draft, pending, notice, result }, ctx) => {
    pending.set(true);
    notice.set("");
    ctx.defer(() => pending.set(false));
    const executionId = ctx.random.uuid();
    const completed = await sync.execute(
      executionId,
      (signal) => updateProfile({ data: { executionId, profile: ctx.input }, signal }),
      ctx.signal,
    );
    result.set({ executionId, result: completed });
    if (completed.kind === "failed") raise("WriteRejected", { message: completed.message });
    draft.set(undefined);
    notice.set(
      completed.kind === "partial"
        ? completed.notification.message
        : "Name saved and notification accepted.",
    );
  },
});
export const retryMail = operation({
  label: "retryMail",
  input: (raw: unknown) => notificationId.parse(raw),
  depends: {
    sync: syncClient,
    pending: pending.controller,
    notice: notice.controller,
    result: profileResult.controller,
  },
  run: async ({ sync, pending, notice, result }, ctx) => {
    pending.set(true);
    ctx.defer(() => pending.set(false));
    const executionId = ctx.random.uuid();
    const completed = await sync.execute(
      executionId,
      (signal) =>
        retryProfileNotification({ data: { executionId, previousExecutionId: ctx.input }, signal }),
      ctx.signal,
    );
    result.set({ executionId, result: completed });
    notice.set(
      completed.kind === "complete"
        ? "Notification accepted. Your saved name stayed the same."
        : completed.kind === "partial"
          ? completed.notification.message
          : completed.message,
    );
  },
});
export const signOut = operation({
  label: "signOut",
  depends: { client: authClient, sync: syncClient, notice: notice.controller },
  run: async ({ client, sync, notice }, ctx) => {
    const result = await client.signOut({ fetchOptions: { signal: ctx.signal } });
    if (result.error) raise("AuthFailed", { message: result.error.message ?? "Sign out failed." });
    sync.leave();
    notice.set("You are signed out. Committed changes remain saved.");
  },
});
export const refreshTools = operation({
  label: "refreshTools",
  depends: { rows: toolRows.controller, read: frontendSpans },
  run: async ({ rows, read }) => {
    rows.set({ backend: await getBackendSpans(), frontend: read() });
  },
});
export const setAuthMode = operation({
  label: "setAuthMode",
  input: (raw: unknown) => modeInput.parse(raw),
  depends: { mode: authMode.controller },
  run: ({ mode }, ctx) => mode.set(ctx.input),
});
export const editName = operation({
  label: "editName",
  input: (raw: unknown) => draftInput.parse(raw),
  depends: { draft: nameDraft.controller },
  run: ({ draft }, ctx) => draft.set(ctx.input),
});
