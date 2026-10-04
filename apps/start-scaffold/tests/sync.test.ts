import { handleAuth } from "@tinker-start-scaffold/transport";
import { test, expect, onTestFinished } from "vite-plus/test";
import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { proofDatabase, proofMail, requestHeaders } from "@tinker-start-scaffold/testing";
import {
  authSettings,
  databaseSettings,
  mailSettings,
  migrate,
  readProfile,
  saveProfile,
  retryNotification,
  bootstrapPublic,
  bootstrapPrivate,
  replayPublic,
  replayPrivate,
  incrementCounter,
  mail,
  raise,
  isError,
} from "@tinker-start-scaffold/backend";
import type { Mail } from "@tinker-start-scaffold/backend";
const tags = [
  databaseSettings({ url: "postgres://proof", migrations: "drizzle" }),
  mailSettings({
    host: "proof",
    port: 25,
    user: "proof",
    password: "proof",
    from: "proof@example.com",
  }),
  authSettings({
    origin: "http://localhost:4318",
    secret: "test-secret-with-at-least-thirty-two-letters",
    plugins: [],
  }),
];
function signup(name: string) {
  return new Request("http://localhost:4318/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:4318" },
    body: JSON.stringify({ name, email: `${name}@example.com`, password: "safe-password-42" }),
  });
}
function headers(response: Response) {
  return new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";").at(0))
      .join("; "),
  });
}
test("concurrent public writes replay in commit order and a repeated receipt changes nothing", async () => {
  const stop = new AbortController();
  const root = createScope({ signal: stop.signal, tags, presets: [proofDatabase, proofMail] });
  await root.ready;
  try {
    await root.run(migrate);
    expect(await root.run(bootstrapPublic)).toEqual({ stream: "public", revision: 0, value: 0 });
    const first = { executionId: crypto.randomUUID() };
    const second = { executionId: crypto.randomUUID() };
    await Promise.all([
      root.run(incrementCounter, { input: first }),
      root.run(incrementCounter, { input: second }),
    ]);
    await root.run(incrementCounter, { input: first });
    const replay = await root.run(replayPublic, {
      input: { after: 0 },
      tags: requestHeaders(new Headers()),
    });
    expect(replay.events.map((event) => event.revision)).toEqual([1, 2, 3, 4]);
    expect(
      replay.events
        .filter((event) => event.payload.kind === "change")
        .map((event) => event.payload),
    ).toEqual([
      { kind: "change", change: { kind: "counter", value: 1 } },
      { kind: "change", change: { kind: "counter", value: 2 } },
    ]);
    expect(await root.run(bootstrapPublic)).toEqual({ stream: "public", revision: 4, value: 2 });
    expect(
      (await root.run(replayPublic, { input: { after: 4 }, tags: requestHeaders(new Headers()) }))
        .events,
    ).toEqual([]);
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});
test("private cursors cannot read another real account's history", async () => {
  const stop = new AbortController();
  const root = createScope({ signal: stop.signal, tags, presets: [proofDatabase, proofMail] });
  await root.ready;
  try {
    await root.run(migrate);
    const ada = headers(
      await root.run(handleAuth, { input: signup("Ada"), tags: requestHeaders(new Headers()) }),
    );
    const grace = headers(
      await root.run(handleAuth, { input: signup("Grace"), tags: requestHeaders(new Headers()) }),
    );
    const snapshot = await root.run(bootstrapPrivate, { tags: requestHeaders(ada) });
    const refused = await root.settle(replayPrivate, {
      input: { accountId: snapshot.stream, after: 0 },
      tags: requestHeaders(grace),
    });
    if (refused.status !== "failed")
      raise("BadInput", { reason: "expected private stream refusal" });
    if (!isError(refused.error, "StreamDenied")) throw refused.error;
    const anonymous = await root.settle(replayPrivate, {
      input: { accountId: snapshot.stream, after: 0 },
      tags: requestHeaders(new Headers()),
    });
    if (anonymous.status !== "failed") raise("BadInput", { reason: "expected sign-in refusal" });
    if (!isError(anonymous.error, "SignInRequired")) throw anonymous.error;
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});
test("failed notification keeps the saved profile and retry sends only the notification", async () => {
  const stop = new AbortController();
  let refuse = true;
  const messages: Mail.Message[] = [];
  const root = createScope({
    signal: stop.signal,
    tags,
    presets: [
      proofDatabase,
      preset(mail, async () => ({
        send: async (message: Mail.Message) => {
          if (message.subject !== "Your profile was updated") return;
          messages.push(message);
          if (refuse) raise("NotificationFailed", {});
        },
      })),
    ],
  });
  await root.ready;
  try {
    await root.run(migrate);
    const account = headers(
      await root.run(handleAuth, { input: signup("Ada"), tags: requestHeaders(new Headers()) }),
    );
    const initial = await root.run(bootstrapPrivate, { tags: requestHeaders(account) });
    const saved = await root.run(saveProfile, {
      input: { executionId: crypto.randomUUID(), profile: { name: "Ada saved" } },
      tags: requestHeaders(account),
    });
    const changes = await root.run(replayPrivate, {
      input: { accountId: initial.stream, after: initial.revision },
      tags: requestHeaders(account),
    });
    expect(changes.map((event) => event.payload.kind)).toEqual(["change", "result"]);
    expect(changes.at(-1)?.payload).toMatchObject({
      kind: "result",
      result: {
        kind: "partial",
        action: "profile",
        profileId: initial.profile.id,
        notification: { kind: "failed" },
      },
    });
    expect(await root.run(readProfile, { tags: requestHeaders(account) })).toMatchObject({
      name: "Ada saved",
    });
    refuse = false;
    await root.run(retryNotification, {
      input: { executionId: crypto.randomUUID(), previousExecutionId: saved.executionId },
      tags: requestHeaders(account),
    });
    const retried = await root.run(replayPrivate, {
      input: { accountId: initial.stream, after: 2 },
      tags: requestHeaders(account),
    });
    expect(retried.map((event) => event.payload)).toEqual([
      {
        kind: "result",
        result: { kind: "complete", action: "profile", profileId: initial.profile.id },
      },
    ]);
    expect(messages.map((message) => message.text)).toEqual([
      "Your saved name is Ada saved.",
      "Your saved name is Ada saved.",
    ]);
    expect(await root.run(readProfile, { tags: requestHeaders(account) })).toMatchObject({
      name: "Ada saved",
    });
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});
test("request exit cannot strand a profile that already committed", async () => {
  const stop = new AbortController();
  const request = new AbortController();
  const sending = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<void>();
  const root = createScope({
    signal: stop.signal,
    tags,
    presets: [
      proofDatabase,
      preset(mail, async () => ({
        send: async (message: Mail.Message) => {
          if (message.subject === "Your profile was updated") {
            sending.resolve();
            await accepted.promise;
          }
        },
      })),
    ],
  });
  await root.ready;
  try {
    await root.run(migrate);
    const account = headers(
      await root.run(handleAuth, { input: signup("Ada"), tags: requestHeaders(new Headers()) }),
    );
    const initial = await root.run(bootstrapPrivate, { tags: requestHeaders(account) });
    const saving = root.settle(saveProfile, {
      input: { executionId: crypto.randomUUID(), profile: { name: "Still saved" } },
      tags: requestHeaders(account),
      signal: request.signal,
    });
    await sending.promise;
    request.abort();
    accepted.resolve();
    await saving;
    const changes = await root.run(replayPrivate, {
      input: { accountId: initial.stream, after: 0 },
      tags: requestHeaders(account),
    });
    expect(changes.at(-1)?.payload).toMatchObject({
      kind: "result",
      result: { kind: "complete", profileId: initial.profile.id },
    });
    expect(await root.run(readProfile, { tags: requestHeaders(account) })).toMatchObject({
      name: "Still saved",
    });
  } finally {
    accepted.resolve();
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("saved names stay readable while duplicate receipts share one pending notification", async () => {
  const stop = new AbortController();
  const sending = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<void>();
  let sends = 0;
  const root = createScope({
    signal: stop.signal,
    tags,
    presets: [
      proofDatabase,
      preset(mail, async () => ({
        send: async (message: Mail.Message) => {
          if (message.subject === "Your profile was updated") {
            sends += 1;
            sending.resolve();
            await accepted.promise;
          }
        },
      })),
    ],
  });
  onTestFinished(async () => {
    accepted.resolve();
    stop.abort();
    await root.closed;
  });
  await root.ready;
  try {
    await root.run(migrate);
    const account = headers(
      await root.run(handleAuth, { input: signup("Ada"), tags: requestHeaders(new Headers()) }),
    );
    const input = { executionId: crypto.randomUUID(), profile: { name: "Visible before mail" } };
    const first = root.settle(saveProfile, { input, tags: requestHeaders(account) });
    await sending.promise;
    const second = root.settle(saveProfile, { input, tags: requestHeaders(account) });
    const saved = await root.run(bootstrapPrivate, { tags: requestHeaders(account) });
    expect(saved.profile.name).toBe("Visible before mail");
    accepted.resolve();
    expect((await Promise.all([first, second])).map((result) => result.status)).toEqual([
      "success",
      "success",
    ]);
    expect(sends).toBe(1);
  } finally {
    accepted.resolve();
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});
