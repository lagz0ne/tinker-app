import { operation, resource } from "@tinker/core";
import { z } from "zod";

import { syncClient, snapshotLoader } from "~/components/sync";

import { credentials } from "@/demo/contracts/credentials";
import type { Errors } from "@/demo/errors";
import { pending, notice, authMode } from "@/demo/frontend/state";

import { betterAuthReact } from "./modules";

const modeInput = z.enum(["signup", "signin"]);

export const authClient = resource({
  label: "browser.auth",
  depends: { auth: betterAuthReact },
  factory: async ({ auth }) => {
    const { createAuthClient } = auth;
    return createAuthClient({
      sessionOptions: { refetchInterval: 300 },
      fetchOptions: {
        onRequest(request) {
          if (
            request.method !== "POST" ||
            !new URL(request.url).pathname.endsWith("/get-session")
          ) {
            return;
          }
          request.headers.set("content-type", "application/json");
          request.body = "{}";
        },
      },
    });
  },
});

export const signIn = operation({
  label: "signIn",
  input: credentials,
  depends: {
    client: authClient,
    sync: syncClient,
    snapshots: snapshotLoader,
    pending: pending.controller,
    notice: notice.controller,
  },
  run: async (
    { client, sync, snapshots, pending, notice },
    { defer, input, signal, log, raise },
  ) => {
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
    if (result.error) {
      return raise("AuthFailed", {
        message: result.error.message ?? "Sign in failed.",
      } satisfies Errors.Payload<"AuthFailed">);
    }

    await snapshots.completeAccountChange(signal, change);
    notice.set("You are signed in. Make a team or ask an admin to add you.");
    log("account.signedIn");
  },
});

export const signOut = operation({
  label: "signOut",
  depends: { client: authClient, sync: syncClient, notice: notice.controller },
  run: async ({ client, sync, notice }, { signal, raise }) => {
    const result = await client.signOut({ fetchOptions: { signal: signal } });
    if (result.error) {
      return raise("AuthFailed", {
        message: result.error.message ?? "Sign out failed.",
      } satisfies Errors.Payload<"AuthFailed">);
    }
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
