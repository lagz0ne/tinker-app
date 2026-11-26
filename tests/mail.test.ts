import { serve } from "@tinkered/bun";
import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import { makeTestClock, memory } from "@tinkered/core/testing";
import { expect, onTestFinished, test } from "vite-plus/test";

import { issues } from "@/issues";
import { mailer } from "@/issues/mail";
import type { Mailer } from "@/issues/mail";
import { issueOps, membersOnly, serverParts, signedIn } from "@/issues/ops.server";
import { signIn, whoMeta } from "@/issues/sign-in";

import { wsClient as tab } from "./support/ws";

// The welcome mail goes through the outbox and the relay. The mailer is a fake on the server's
// `mailer` tag; time is the server's test clock. The last test runs the real server cmd.

/** A fake mailer. `fail`: the next sends throw. `hang`: each send never answers. `slow`: each send
 * answers after that many ms on the server's clock. `sent` holds each mail whose send answered. */
const fakeMail = (clock: ReturnType<typeof makeTestClock>) => {
  const sent: { to: string; subject: string; body: string }[] = [];
  const state = { tries: 0, fail: 0, hang: false, slow: 0 };
  const mail: Mailer = {
    send: async (to, subject, body) => {
      state.tries += 1;
      if (state.hang) return new Promise<void>(() => undefined);
      if (state.fail > 0) {
        state.fail -= 1;
        throw new Error("mail is down");
      }
      if (state.slow) await clock.sleep(state.slow);
      sent.push({ to, subject, body });
    },
  };
  return { mail, sent, state };
};

/** A server with the app's server parts, the fake mailer and a test clock, over `memory`, and
 * ana's tab. Ana made `MAIL`. `pass(ms)` moves the clock in 100 ms steps, letting work run. */
const mailWorld = async () => {
  const clock = makeTestClock({ now: 1_000_000 });
  const fake = fakeMail(clock);

  const server = await createScope({
    clock,
    tags: [mailer(fake.mail)],
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
      ...serverParts,
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const tabOf = async (name: string) => {
    const scope = await createScope({
      capsules: [
        exits({ file: process.env.TINKER_EXITS }),
        memory.client({ peer: server, meta: whoMeta }),
        issues.board({ read: memory.client }),
        issues.api({ remote: memory.client }),
      ],
    }).ready;
    scope.run(signIn, { input: { name } });
    return scope;
  };

  const ana = await tabOf("ana");
  onTestFinished(async () => {
    fake.state.hang = false;
    await ana.close();
    await server.close();
  });
  await ana.run(issues.api["team.create"], { input: { teamId: "MAIL" } });

  const add = (userId: string, role: "member" | "viewer" = "member") =>
    ana.run(issues.api["team.add"], { input: { teamId: "MAIL", userId, role } });
  const pass = async (ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      clock.advance(100);
      await new Promise((r) => setTimeout(r, 1));
    }
  };
  return { fake, server, ana, add, tabOf, pass };
};

test("a person added gets one welcome mail; a role change or a refused add sends none", async () => {
  const { fake, add, ana, tabOf, pass } = await mailWorld();

  expect(await add("bo")).toEqual({ kind: "added" });
  await pass(2_000);
  expect(fake.sent.map((m) => [m.to, m.subject])).toEqual([["bo", "Welcome to MAIL"]]);
  // A role change of a person in the team is not a welcome.
  expect(await add("bo", "viewer")).toEqual({ kind: "added" });
  expect(await add("bo", "member")).toEqual({ kind: "added" });
  expect(await add("cy", "viewer")).toEqual({ kind: "added" });
  // Refused adds send nothing: gone, forbidden, archived.
  const cy = await tabOf("cy");
  const dee = await tabOf("dee");
  const tryAdd = { input: { teamId: "MAIL", userId: "eve", role: "member" as const } };
  expect(await dee.run(issues.api["team.add"], tryAdd)).toEqual({ kind: "gone" });
  expect(await cy.run(issues.api["team.add"], tryAdd)).toEqual({ kind: "forbidden" });
  await ana.run(issues.api["team.archive"], { input: { teamId: "MAIL" } });
  expect(await ana.run(issues.api["team.add"], tryAdd)).toEqual({ kind: "archived" });
  await pass(5_000);
  expect(fake.sent.map((m) => [m.to, m.subject])).toEqual([
    ["bo", "Welcome to MAIL"],
    ["cy", "Welcome to MAIL"],
  ]);
  expect(fake.state.tries).toBe(2);
  await cy.close();
  await dee.close();
});

test("mail is down once: the add answers, and the mail arrives once mail is back", async () => {
  const { fake, add, pass } = await mailWorld();
  fake.state.fail = 1;

  expect(await add("bo")).toEqual({ kind: "added" });
  await pass(60_000);
  expect(fake.sent.map((m) => m.to)).toEqual(["bo"]);
  expect(fake.state.tries).toBe(2);
  await pass(60_000);
  expect(fake.sent.map((m) => m.to)).toEqual(["bo"]);
});

test("mail never answers: the add answers at once; the mail is tried again after 10 s, once", async () => {
  const { fake, add, pass } = await mailWorld();
  fake.state.hang = true;

  // The call answers with no time passing: it does not wait for the mail.
  expect(await add("bo")).toEqual({ kind: "added" });
  await pass(1_000);
  expect(fake.state.tries).toBe(1);
  fake.state.hang = false;
  // The first send may still answer for 10 s: nobody sends the mail again before that.
  await pass(8_000);
  expect(fake.state.tries).toBe(1);
  await pass(60_000);
  expect(fake.sent.map((m) => m.to)).toEqual(["bo"]);
  expect(fake.state.tries).toBe(2);
});

test("slow mail: sends that take 3 s are not sent again; each person gets one mail", async () => {
  const { fake, add, pass } = await mailWorld();
  fake.state.slow = 3_000;

  await add("bo");
  await add("cy");
  await add("dee");
  await pass(30_000);
  expect(fake.sent.map((m) => m.to).toSorted()).toEqual(["bo", "cy", "dee"]);
  expect(fake.state.tries).toBe(3);
});

test("the server cmd prints the welcome mail; the add answers first", async () => {
  type Server = typeof import("../cmds/server");
  const cmd: Server = await import(new URL("../cmds/server.ts", import.meta.url).href);

  const sink = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
  const lines: string[] = [];
  const stop = new AbortController();
  const root = await cmd.default({
    env: {
      PORT: "0",
      OTEL_SERVICE_NAME: "mail-test",
      VICTORIA_TRACES_URL: `${sink.url}traces`,
      VICTORIA_LOGS_URL: `${sink.url}logs`,
    },
    args: [],
    cwd: process.cwd(),
    signal: stop.signal,
    stdout: {
      write: (x: string) => {
        lines.push(String(x));
        return true;
      },
    },
    stderr: { write: () => true },
    exit: (code, reason) => stop.abort(reason ?? code),
  });
  onTestFinished(async () => {
    stop.abort();
    await sink.stop(true);
  });
  if (!("resolve" in root)) throw new Error("the server cmd gave no scope");

  const at = root.resolve(serve.url).get();
  const ws = await createScope({
    capsules: [tab.client({ url: `${at}rpc`, meta: whoMeta }), issues.api({ remote: tab.client })],
  }).ready;
  ws.run(signIn, { input: { name: "ana" } });
  await ws.run(issues.api["team.create"], { input: { teamId: "CMD" } });
  expect(
    await ws.run(issues.api["team.add"], {
      input: { teamId: "CMD", userId: "bo", role: "member" },
    }),
  ).toEqual({ kind: "added" });

  const end = Date.now() + 8000;
  while (!lines.some((l) => l.includes("mail to bo: Welcome to CMD")) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(lines.filter((l) => l.includes("Welcome to CMD"))).toEqual([
    "mail to bo: Welcome to CMD\n",
  ]);
  await ws.close();
}, 20_000);
