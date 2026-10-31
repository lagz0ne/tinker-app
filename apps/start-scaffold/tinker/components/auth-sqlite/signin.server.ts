import { operation, resource } from "@tinker/core";
import { z } from "zod";

import { raise } from "~/components/errors";

import { auth } from "./auth.server";
import { mcpCaller } from "./mcp.server";

/** The code's row, with the code sign-in's own columns. */
type Waiting = {
  id: string;
  userCode: string;
  userId: string | null;
  status: string;
  expiresAt: Date;
  signinBrowser: string | null;
  /** The OAuth client a start from the login page names; none for a plain sign-in. */
  signinClient: string | null;
};

type CodeSession = {
  id: string;
  token: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  signinCode: string | null;
  signinBrowser: string | null;
  signinApprovedBy: string | null;
};

/** A code waits 10 minutes, so it was asked for 10 minutes before it ends. */
const codeMs = 600_000;

/** Ten wrong codes in 15 minutes lock approvals, as obelisk. */
const missWindowMs = 900_000;

const missCap = 10;

/** This process's wrong codes: when each came, by Core's clock. */
const signinMisses = resource({
  label: "auth.signinMisses",
  target: "scope",
  factory: () => ({ times: [] as number[] }),
});

export const approveSigninInput = z.object({ code: z.string().max(20) });

export const listSigninsInput = z.object({});

export const endSigninInput = z.object({ id: z.string().max(40) });

/**
 * The caller approves a code that a browser shows: that browser signs in as the caller. Case,
 * spaces, and the dash do not matter. One approve wins a race: the write checks the row still
 * waits.
 */
export const approveSignin = operation({
  label: "auth.approveSignin",
  input: approveSigninInput,
  depends: { auth, caller: mcpCaller, misses: signinMisses },
  run: async ({ auth, caller, misses }, { input, clock }) => {
    const now = clock.currentTimeMillis();

    misses.times = misses.times.filter((at) => now - at < missWindowMs);

    if (misses.times.length >= missCap) {
      raise("Refused", {
        message: "Too many wrong codes. Wait 15 minutes, then ask for a new code.",
      });
    }

    const { adapter } = await auth.$context;

    // No user code is empty, so a code of no letters finds no row.
    const row = await adapter.findOne<Waiting>({
      model: "deviceCode",
      where: [
        { field: "userCode", value: input.code.toUpperCase().replace(/[^A-Z]/g, "") },
        { field: "clientId", value: "web" },
      ],
    });

    // The row's end is Better Auth's own time, so it is read by the wall clock it was set with.
    if (!row || row.expiresAt <= new Date()) {
      misses.times.push(now);

      raise("Refused", {
        message: `No sign-in waits for code "${input.code.slice(0, 12)}". A code works for 10 minutes; ask for the code on the page again.`,
      });
    }

    const shown = `${row.userCode.slice(0, 4)}-${row.userCode.slice(4)}`;

    // The write is its own guard: it changes the row only while it still waits.
    const approved = await adapter.incrementOne<Waiting>({
      model: "deviceCode",
      where: [
        { field: "id", value: row.id },
        { field: "status", value: "pending" },
      ],
      increment: {},
      set: { status: "approved", userId: caller.userId, signinApprovedBy: caller.clientId },
    });

    if (!approved) raise("Refused", { message: `Code ${shown} is already approved.` });

    const asked = new Date(row.expiresAt.getTime() - codeMs).toISOString().slice(11, 16);

    const what = row.signinClient ? `"Allow access" for ${row.signinClient}` : "sign-in";

    return {
      text: `Approved code ${shown} (${row.signinBrowser ?? "a browser"}, ${what}, asked at ${asked} UTC). That page goes on by itself within a few seconds. The code is used up once it does.`,
    };
  },
});

/**
 * The codes that wait, and the caller's own code sign-ins. A waiting code shows only to the one
 * who approved it: many users share one server, and a code is a key until it is used.
 */
export const listSignins = operation({
  label: "auth.listSignins",
  input: listSigninsInput,
  depends: { auth, caller: mcpCaller },
  run: async ({ auth, caller }) => {
    const { adapter } = await auth.$context;

    const now = new Date();

    const rows = await adapter.findMany<Waiting>({
      model: "deviceCode",
      where: [
        { field: "clientId", value: "web" },
        { field: "expiresAt", operator: "gt", value: now },
      ],
    });

    const waiting = rows.map((row) => ({
      at: new Date(row.expiresAt.getTime() - codeMs).toISOString(),
      browser: row.signinBrowser ?? "a browser",
      kind: row.signinClient ? ("oauth" as const) : ("web" as const),
      approved: row.status === "approved",
      ...(row.status === "approved" && row.userId === caller.userId
        ? { code: `${row.userCode.slice(0, 4)}-${row.userCode.slice(4)}` }
        : {}),
    }));

    const sessions = await adapter.findMany<CodeSession>({
      model: "session",
      where: [{ field: "userId", value: caller.userId }],
    });

    const active = sessions
      .filter((session) => session.signinCode && session.expiresAt > now)
      .map((session) => ({
        id: session.id,
        at: session.createdAt.toISOString(),
        browser: session.signinBrowser ?? "a browser",
        code: `${session.signinCode?.slice(0, 4)}-${session.signinCode?.slice(4)}`,
        approvedBy: session.signinApprovedBy,
      }));

    const codes = waiting.length
      ? waiting
          .map(
            (item) =>
              `${item.code ?? "a code"} (${item.browser}, ${item.kind === "oauth" ? "Allow access" : "sign-in"}, asked ${item.at.slice(11, 16)} UTC${item.approved ? ", approved" : ""})`,
          )
          .join("; ")
      : "none";

    const signedIn = active.length
      ? active
          .map(
            (item) =>
              `${item.id}: ${item.browser}, since ${item.at.slice(0, 16).replace("T", " ")} UTC (code ${item.code})`,
          )
          .join("; ")
      : "none";

    return {
      text: `Waiting codes: ${codes}.\nSigned in with a code: ${signedIn}.`,
      data: { waiting, active },
    };
  },
});

/**
 * End one of the caller's code sign-ins. The delete goes through Better Auth, so the session
 * delete hooks speak (the sync notice and the account notice), as a sign-out does.
 */
export const endSignin = operation({
  label: "auth.endSignin",
  input: endSigninInput,
  depends: { auth, caller: mcpCaller },
  run: async ({ auth, caller }, { input }) => {
    const { adapter, internalAdapter } = await auth.$context;

    const session = await adapter.findOne<CodeSession>({
      model: "session",
      where: [
        { field: "id", value: input.id },
        { field: "userId", value: caller.userId },
      ],
    });

    if (!session?.signinCode) {
      raise("Refused", {
        message: `No code sign-in "${input.id}". List the code sign-ins to see their ids.`,
      });
    }

    await internalAdapter.deleteSession(session.token);

    return { text: `Ended sign-in ${input.id}: that browser must sign in again.` };
  },
});
