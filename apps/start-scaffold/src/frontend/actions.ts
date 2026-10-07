import { operation, resource } from "@tinker/core";
import { z } from "zod";
import { updateProfile, retryProfileNotification } from "../transport/profile.functions.ts";
import { nameDraft, pending, notice, authMode, profileResult } from "./state.ts";
import { syncClient } from "@tinker/start/client";
import { snapshotLoader } from "@tinker/start/client";
import { credentials } from "../contracts/credentials.ts";
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
  input: (raw: unknown) => {
    const parsed = credentials.safeParse(raw);
    if (!parsed.success) raise("BadInput", { reason: "Check your email and password." });
    return parsed.data;
  },
  depends: {
    client: authClient,
    sync: syncClient,
    snapshots: snapshotLoader,
    pending: pending.controller,
    notice: notice.controller,
  },
  run: async ({ client, sync, snapshots, pending, notice }, { defer, input, signal, log }) => {
    pending.set(true);
    notice.set("");
    defer(() => pending.set(false));
    const change = snapshots.beginAccountChange();
    defer(() => snapshots.endAccountChange(change));
    sync.leave();
    const result =
      input.mode === "signup"
        ? await client.signUp.email(input, { signal: signal })
        : await client.signIn.email(input, { signal: signal });
    if (result.error) raise("AuthFailed", { message: result.error.message ?? "Sign in failed." });
    await snapshots.completeAccountChange(signal, change);
    notice.set("You are signed in. Open your profile or private list.");
    log("account.signedIn");
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
  run: async ({ sync, draft, pending, notice, result }, { defer, random, input, signal }) => {
    pending.set(true);
    notice.set("");
    defer(() => pending.set(false));
    const executionId = random.uuid();
    const completed = await sync.execute(
      executionId,
      { send: updateProfile, data: { executionId, profile: input } },
      signal,
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
  run: async ({ sync, pending, notice, result }, { defer, random, input, signal }) => {
    pending.set(true);
    defer(() => pending.set(false));
    const executionId = random.uuid();
    const completed = await sync.execute(
      executionId,
      { send: retryProfileNotification, data: { executionId, previousExecutionId: input } },
      signal,
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
  run: async ({ client, sync, notice }, { signal }) => {
    const result = await client.signOut({ fetchOptions: { signal: signal } });
    if (result.error) raise("AuthFailed", { message: result.error.message ?? "Sign out failed." });
    sync.leave();
    notice.set("You are signed out. Committed changes remain saved.");
  },
});
export const setAuthMode = operation({
  label: "setAuthMode",
  input: (raw: unknown) => modeInput.parse(raw),
  depends: { mode: authMode.controller },
  run: ({ mode }, { input }) => mode.set(input),
});
export const editName = operation({
  label: "editName",
  input: (raw: unknown) => draftInput.parse(raw),
  depends: { draft: nameDraft.controller },
  run: ({ draft }, { input }) => draft.set(input),
});
