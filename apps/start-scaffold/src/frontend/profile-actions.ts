import { operation } from "@tinker/core";
import { z } from "zod";
import { updateProfile, retryProfileNotification } from "../transport/profile.functions";
import { nameDraft, pending, notice, profileResult } from "./state";
import { syncClient } from "@tinker/start/client";
import { readProfileInput } from "../contracts/profile";
import { raise } from "../errors";
const notificationId = z.uuid();
const draftInput = z.string();
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
export const editName = operation({
  label: "editName",
  input: (raw: unknown) => draftInput.parse(raw),
  depends: { draft: nameDraft.controller },
  run: ({ draft }, { input }) => draft.set(input),
});
