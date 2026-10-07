import { operation, resource } from "@tinker/core";
import { z } from "zod";
import { pending, notice, authMode } from "./state.ts";
import { syncClient, snapshotLoader } from "@tinker/start/client";
import { credentials } from "../contracts/credentials.ts";
import { raise } from "../errors.ts";
const modeInput = z.enum(["signup", "signin"]);
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
