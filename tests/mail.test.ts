import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import { makeTestClock, memory } from "@tinkered/core/testing";
import { expect, onTestFinished, test } from "vite-plus/test";

import { issues } from "@/issues";
import { mailer } from "@/issues/mail";
import type { Mailer } from "@/issues/mail";
import { issueOps, membersOnly, signedIn } from "@/issues/ops.server";
import { drainMail } from "@/issues/outbox.server";
import { signIn, whoMeta } from "@/issues/sign-in";

// The welcome mail goes through the outbox. The mailer is a fake on the server's `mailer` tag;
// time is the server's test clock.

const until = async (ok: () => boolean) => {
  const end = Date.now() + 8000;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A fake mailer: it can throw for the next sends, hang every send, or hold every send until
 * the test opens it. `sent` holds each mail whose send answered. */
const fakeMail = () => {
  const sent: { to: string; subject: string; body: string }[] = [];
  const state = { tries: 0, fail: 0, hang: false, gate: Promise.resolve() };
  const mail: Mailer = {
    send: async (to, subject, body) => {
      state.tries += 1;
      if (state.hang) return new Promise<void>(() => undefined);
      if (state.fail > 0) {
        state.fail -= 1;
        throw new Error("mail is down");
      }
      await state.gate;
      sent.push({ to, subject, body });
    },
  };
  return { mail, sent, state };
};

/** A server with that mailer and a test clock, over `memory`, and ana's tab. Ana made `MAIL`. */
const mailWorld = async (mail: Mailer) => {
  const clock = makeTestClock({ now: 1_000_000 });

  const server = await createScope({
    clock,
    tags: [mailer(mail)],
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
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
    await ana.close();
    await server.close();
  });
  await ana.run(issues.api["team.create"], { input: { teamId: "MAIL" } });

  const add = (userId: string, role: "member" | "viewer" = "member") =>
    ana.run(issues.api["team.add"], { input: { teamId: "MAIL", userId, role } });
  return { clock, server, ana, add, tabOf };
};

test("a person added gets one welcome mail; a role change or a refused add sends none", async () => {
  const fake = fakeMail();
  const { server, add, ana, tabOf } = await mailWorld(fake.mail);

  expect(await add("bo")).toEqual({ kind: "added" });
  await server.run(drainMail);
  expect(fake.sent).toHaveLength(1);
  expect(fake.sent[0]).toMatchObject({ to: "bo", subject: "Welcome to MAIL" });
  // A role change of a person in the team is not a welcome.
  expect(await add("bo", "viewer")).toEqual({ kind: "added" });
  expect(await add("bo", "member")).toEqual({ kind: "added" });
  expect(await add("cy", "viewer")).toEqual({ kind: "added" });
  await server.run(drainMail);
  expect(fake.sent.map((m) => [m.to, m.subject])).toEqual([
    ["bo", "Welcome to MAIL"],
    ["cy", "Welcome to MAIL"],
  ]);
  // Refused adds send nothing: gone, forbidden, archived.
  const cy = await tabOf("cy");
  const dee = await tabOf("dee");
  const tryAdd = { input: { teamId: "MAIL", userId: "eve", role: "member" as const } };
  expect(await dee.run(issues.api["team.add"], tryAdd)).toEqual({ kind: "gone" });
  expect(await cy.run(issues.api["team.add"], tryAdd)).toEqual({ kind: "forbidden" });
  await ana.run(issues.api["team.archive"], { input: { teamId: "MAIL" } });
  expect(await ana.run(issues.api["team.add"], tryAdd)).toEqual({ kind: "archived" });
  await server.run(drainMail);
  await server.run(drainMail);
  expect(fake.sent.map((m) => m.to)).toEqual(["bo", "cy"]);
  expect(fake.state.tries).toBe(2);
  await cy.close();
  await dee.close();
});

test("mail is down once: the add answers, and a later drain sends the mail once", async () => {
  const fake = fakeMail();
  fake.state.fail = 1;
  const { server, add } = await mailWorld(fake.mail);

  expect(await add("bo")).toEqual({ kind: "added" });
  await server.run(drainMail);
  expect(fake.state.tries).toBe(1);
  expect(fake.sent).toEqual([]);
  await server.run(drainMail);
  await server.run(drainMail);
  expect(fake.sent.map((m) => m.to)).toEqual(["bo"]);
  expect(fake.state.tries).toBe(2);
});

test("mail never answers: the add answers; after the limit a later drain sends it once", async () => {
  const fake = fakeMail();
  fake.state.hang = true;
  const { clock, server, add } = await mailWorld(fake.mail);

  // The call answers with no time passing: it does not wait for the mail.
  expect(await add("bo")).toEqual({ kind: "added" });
  const first = server.run(drainMail);
  await until(() => fake.state.tries === 1);
  fake.state.hang = false;
  // The first send is still out: a second drain now does not send the mail again.
  await server.run(drainMail);
  expect(fake.state.tries).toBe(1);
  // 5 s on the scope clock: the first drain gives up on its send, and the mail waits again.
  clock.advance(5_000);
  await first;
  expect(fake.sent).toEqual([]);
  await server.run(drainMail);
  await server.run(drainMail);
  expect(fake.sent.map((m) => m.to)).toEqual(["bo"]);
  expect(fake.state.tries).toBe(2);
});

test("two drains at once send each mail once", async () => {
  const fake = fakeMail();
  const { server, add } = await mailWorld(fake.mail);
  let open: () => void = () => undefined;
  fake.state.gate = new Promise<void>((done) => {
    open = done;
  });

  await add("bo");
  await add("cy");
  // Both drains start while the sends hold at the gate.
  const both = Promise.all([server.run(drainMail), server.run(drainMail)]);
  await until(() => fake.state.tries >= 1);
  await new Promise((r) => setTimeout(r, 50));
  open();
  await both;
  await server.run(drainMail);
  expect(fake.sent.map((m) => m.to).toSorted()).toEqual(["bo", "cy"]);
  expect(fake.state.tries).toBe(2);
});
