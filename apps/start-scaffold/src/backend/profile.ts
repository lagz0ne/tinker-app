import { operation, resource } from "@tinker/core";
import { principal, currentUser } from "./auth";
import { database } from "./database";
import { sendMail } from "./mail";
import { eventHistory } from "@tinker/start/server";
import { readProfileCommand } from "../contracts/commands";
import { readExecution, readRetry, readFeatureResult } from "../contracts/sync";
import type { Sync } from "../contracts/sync";
import type { Profile } from "../contracts/profile";
import { raise } from "../errors";
export const readProfile = operation({
  label: "readProfile",
  depends: { principal, database },
  run: async ({ principal, database }): Promise<Profile.Value | null> => {
    if (principal === null) return null;
    const [{ eq }, { user }] = await Promise.all([import("drizzle-orm"), import("./schema")]);
    return (
      (
        await database
          .select({
            id: user.id,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
          })
          .from(user)
          .where(eq(user.id, principal.id))
      ).at(0) ?? null
    );
  },
});
/** Mail runs after commit and outside a database lock; only its final event needs a transaction. */
const notifyProfile = operation({
  label: "notifyProfile",
  input: readExecution,
  depends: { database, history: eventHistory, send: sendMail },
  run: async ({ database, history, send }, { input }) => {
    const [{ eq }, { execution }] = await Promise.all([
      import("drizzle-orm"),
      import("@tinker/start/server"),
    ]);
    const stored = (
      await database.select().from(execution).where(eq(execution.id, input.executionId))
    ).at(0);
    if (!stored?.notification) raise("RetryNotAvailable", {});
    if (stored.result) return { executionId: input.executionId };
    const sent = await send.settle({ rawInput: stored.notification });
    const result: Sync.Result =
      sent.status === "success"
        ? { kind: "complete", action: "profile", profileId: stored.stream }
        : {
            kind: "partial",
            action: "profile",
            profileId: stored.stream,
            notification: {
              kind: "failed",
              message: "Name saved; notification failed. You can retry the notification.",
            },
          };
    await database.transaction(async (tx) => {
      await history.lock(tx, stored.stream);
      const latest = await history.find(tx, input.executionId, stored.stream);
      if (latest?.result) return;
      await history.append(tx, stored.stream, input.executionId, [{ kind: "result", result }]);
    });
    return { executionId: input.executionId };
  },
});
/** One process owner coalesces duplicate requests; this is not a cross-process SMTP guarantee. */
const notificationWork = resource({
  label: "profile.notificationWork",
  depends: { finish: notifyProfile },
  factory: ({ finish }) => {
    const running = new Map<string, Promise<Sync.Receipt>>();
    return {
      finish(executionId: string) {
        const existing = running.get(executionId);
        if (existing) return existing;
        const completed = finish
          .run({ input: { executionId } })
          .finally(() => running.delete(executionId));
        running.set(executionId, completed);
        return completed;
      },
    };
  },
});
export const saveProfile = operation({
  label: "saveProfile",
  input: readProfileCommand,
  depends: { currentUser, database, history: eventHistory, notify: notificationWork },
  run: async ({ currentUser, database, history, notify }, { input, clock }) => {
    const [{ eq }, { user }, { execution }] = await Promise.all([
      import("drizzle-orm"),
      import("./schema"),
      import("@tinker/start/server"),
    ]);
    await database.transaction(async (tx) => {
      await history.lock(tx, currentUser.id);
      if (await history.find(tx, input.executionId, currentUser.id)) return;
      const saved = (
        await tx
          .update(user)
          .set({ name: input.profile.name, updatedAt: new Date(clock.currentTimeMillis()) })
          .where(eq(user.id, currentUser.id))
          .returning({
            id: user.id,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
          })
      ).at(0);
      if (!saved) raise("SignInRequired", {});
      await tx.insert(execution).values({
        id: input.executionId,
        stream: currentUser.id,
        notification: {
          to: saved.email,
          subject: "Your profile was updated",
          text: `Your saved name is ${saved.name}.`,
        },
      });
      await history.append(tx, currentUser.id, input.executionId, [
        { kind: "change", change: { kind: "profile", profile: saved } },
      ]);
    });
    return notify.finish(input.executionId);
  },
});
export const retryNotification = operation({
  label: "retryNotification",
  input: readRetry,
  depends: { currentUser, database, history: eventHistory, notify: notificationWork },
  run: async ({ currentUser, database, history, notify }, { input }) => {
    const { execution } = await import("@tinker/start/server");
    await database.transaction(async (tx) => {
      await history.lock(tx, currentUser.id);
      if (await history.find(tx, input.executionId, currentUser.id)) return;
      const previous = await history.find(tx, input.previousExecutionId, currentUser.id);
      if (
        !previous?.notification ||
        !previous.result ||
        readFeatureResult.parse(previous.result).kind !== "partial"
      )
        raise("RetryNotAvailable", {});
      await tx.insert(execution).values({
        id: input.executionId,
        stream: currentUser.id,
        notification: previous.notification,
      });
    });
    return notify.finish(input.executionId);
  },
});
