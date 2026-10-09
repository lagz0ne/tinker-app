import { env } from "@tinker/start/server";
import { handleAuth } from "@tinker-start-scaffold/testing";
import { proofDatabase, proofMail, requestHeaders } from "@tinker-start-scaffold/testing";
import { test, expect, onTestFinished } from "vite-plus/test";
import { createScope, operation } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { sql } from "drizzle-orm";
import {
  auth,
  readProfile,
  saveProfile,
  database,
  mail,
  migrate,
  raise,
  isError,
} from "@tinker-start-scaffold/backend";
import type { Mail } from "@tinker-start-scaffold/backend";

const tags = env({
  DATABASE_URL: "postgres://proof",
  SMTP_HOST: "proof",
  SMTP_PORT: "25",
  SMTP_USER: "proof",
  SMTP_PASSWORD: "proof",
  SMTP_FROM: "proof@example.com",
  PUBLIC_ORIGIN: "http://localhost:4318",
  AUTH_SECRET: "test-secret-with-at-least-thirty-two-letters",
});

function authRequest(path: string, body: object, cookie = "") {
  return new Request(`http://localhost:4318/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:4318", cookie },
    body: JSON.stringify(body),
  });
}

function readCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";").at(0))
    .join("; ");
}

const failAfterSave = operation({
  label: "test.failAfterSave",
  depends: { save: saveProfile },
  run: async ({ save }) => {
    await save.run({
      input: {
        executionId: "10000000-0000-4000-8000-000000000001",
        profile: { name: "Discard me" },
      },
    });
    raise("BadInput", { reason: "stop after write" });
  },
});

test("a real account can sign up, save its name, sign out and sign in", async () => {
  const messages: Mail.Message[] = [];
  const stop = new AbortController();
  const root = createScope({
    signal: stop.signal,
    tags,
    presets: [
      proofDatabase,
      preset(mail, async () => ({
        send: async (message: Mail.Message) => {
          messages.push(message);
        },
      })),
    ],
  });
  await root.ready;
  try {
    await root.run(migrate);
    const signup = await root.run(handleAuth, {
      input: authRequest("sign-up/email", {
        name: "Ada",
        email: "ada@example.com",
        password: "safe-password-42",
      }),
      tags: requestHeaders(new Headers()),
    });
    expect(signup.status).toBe(200);
    const cookie = readCookie(signup);
    await expect.poll(() => messages.at(0)?.subject).toBe("Check your email");
    const saved = await root.run(saveProfile, {
      input: {
        executionId: "10000000-0000-4000-8000-000000000002",
        profile: { name: "Ada Lovelace" },
      },
      tags: requestHeaders(new Headers({ cookie })),
    });
    expect(saved.executionId).toBe("10000000-0000-4000-8000-000000000002");
    expect(
      await root.run(readProfile, { tags: requestHeaders(new Headers({ cookie })) }),
    ).toMatchObject({ name: "Ada Lovelace", email: "ada@example.com" });
    const signout = await root.run(handleAuth, {
      input: authRequest("sign-out", {}, cookie),
      tags: requestHeaders(new Headers({ cookie })),
    });
    expect(signout.status).toBe(200);
    expect(
      await root.run(readProfile, { tags: requestHeaders(new Headers({ cookie })) }),
    ).toBeNull();
    const signin = await root.run(handleAuth, {
      input: authRequest("sign-in/email", {
        email: "ada@example.com",
        password: "safe-password-42",
      }),
      tags: requestHeaders(new Headers()),
    });
    expect(
      await root.run(readProfile, {
        tags: requestHeaders(new Headers({ cookie: readCookie(signin) })),
      }),
    ).toMatchObject({ name: "Ada Lovelace" });
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("a refused save leaves the root usable", async () => {
  const stop = new AbortController();
  const root = createScope({
    signal: stop.signal,
    tags,
    presets: [proofDatabase, proofMail],
    observe: { history: 80 },
  });
  await root.ready;
  try {
    await root.run(migrate);
    const result = await root.settle(saveProfile, {
      input: {
        executionId: "10000000-0000-4000-8000-000000000003",
        profile: { name: "No account" },
      },
      tags: requestHeaders(new Headers()),
    });
    if (result.status !== "failed") raise("BadInput", { reason: "expected refusal" });
    if (!isError(result.error, "SignInRequired")) throw result.error;
    expect(await root.run(readProfile, { tags: requestHeaders(new Headers()) })).toBeNull();
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("a later action failure cannot undo a committed profile save", async () => {
  const stop = new AbortController();
  const root = createScope({ signal: stop.signal, tags, presets: [proofDatabase, proofMail] });
  await root.ready;
  try {
    await root.run(migrate);
    const signup = await root.run(handleAuth, {
      input: authRequest("sign-up/email", {
        name: "Ada",
        email: "ada@example.com",
        password: "safe-password-42",
      }),
      tags: requestHeaders(new Headers()),
    });
    const headers = new Headers({ cookie: readCookie(signup) });
    const result = await root.settle(failAfterSave, { tags: requestHeaders(headers) });
    if (result.status !== "failed") raise("BadInput", { reason: "expected failed action" });
    if (!isError(result.error, "BadInput")) throw result.error;
    expect(await root.run(readProfile, { tags: requestHeaders(headers) })).toMatchObject({
      name: "Discard me",
    });
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("a native commit failure never returns a saved profile", async () => {
  const stop = new AbortController();
  const root = createScope({ signal: stop.signal, tags, presets: [proofDatabase, proofMail] });
  await root.ready;
  try {
    await root.run(migrate);
    await root.run(handleAuth, {
      input: authRequest("sign-up/email", {
        name: "Grace",
        email: "grace@example.com",
        password: "safe-password-42",
      }),
      tags: requestHeaders(new Headers()),
    });
    const signup = await root.run(handleAuth, {
      input: authRequest("sign-up/email", {
        name: "Ada",
        email: "ada@example.com",
        password: "safe-password-42",
      }),
      tags: requestHeaders(new Headers()),
    });
    const headers = new Headers({ cookie: readCookie(signup) });
    const db = await root.resolve(database);
    await db.execute(
      sql`ALTER TABLE "user" ADD CONSTRAINT proof_name_unique UNIQUE (name) DEFERRABLE INITIALLY DEFERRED`,
    );
    const result = await root.settle(saveProfile, {
      input: { executionId: "10000000-0000-4000-8000-000000000004", profile: { name: "Grace" } },
      tags: requestHeaders(headers),
    });
    expect(result.status).toBe("failed");
    expect(await root.run(readProfile, { tags: requestHeaders(headers) })).toMatchObject({
      name: "Ada",
    });
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("email check and reset callbacks use the declared mail action", async () => {
  const messages: Mail.Message[] = [];
  const stop = new AbortController();
  const root = createScope({
    signal: stop.signal,
    tags,
    presets: [
      proofDatabase,
      preset(mail, async () => ({
        send: async (message: Mail.Message) => {
          messages.push(message);
        },
      })),
    ],
  });
  await root.ready;
  try {
    await root.run(migrate);
    await root.run(handleAuth, {
      input: authRequest("sign-up/email", {
        name: "Ada",
        email: "ada@example.com",
        password: "safe-password-42",
      }),
      tags: requestHeaders(new Headers()),
    });
    await expect
      .poll(() => messages.some((message) => message.subject === "Check your email"))
      .toBe(true);
    const check = messages.find((message) => message.subject === "Check your email");
    if (!check) raise("BadInput", { reason: "missing check link" });
    const checked = await root.run(handleAuth, {
      input: new Request(check.text),
      tags: requestHeaders(new Headers()),
    });
    expect(checked.status).toBe(302);
    await root.run(handleAuth, {
      input: authRequest("request-password-reset", {
        email: "ada@example.com",
        redirectTo: "http://localhost:4318/",
      }),
      tags: requestHeaders(new Headers()),
    });
    await expect
      .poll(() => messages.some((message) => message.subject === "Reset your password"))
      .toBe(true);
    const reset = messages.find((message) => message.subject === "Reset your password");
    if (!reset) raise("BadInput", { reason: "missing reset link" });
    expect(new URL(reset.text).pathname).toContain("/reset-password/");
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("two requests share the auth instance", async () => {
  const root = createScope({ tags, presets: [proofDatabase, proofMail] });
  await root.ready;
  try {
    const first = await root.session(
      { tags: requestHeaders(new Headers({ cookie: "first" })) },
      (session) => session.resolve(auth),
    );
    const second = await root.session(
      { tags: requestHeaders(new Headers({ cookie: "second" })) },
      (session) => session.resolve(auth),
    );
    expect(first).toBe(second);
  } finally {
    expect((await root.close({ graceful: true })).status).toBe("success");
  }
});

test("sign-up replies before held mail and logs its failure", async () => {
  const accepted = Promise.withResolvers<void>();
  const sending = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  const stop = new AbortController();
  const root = createScope({
    signal: stop.signal,
    tags,
    observe: {
      log: (entry) => {
        if (entry.message === "mail.failed" && entry.level === 50) failed.resolve();
      },
    },
    presets: [
      proofDatabase,
      preset(mail, async () => ({
        send: async () => {
          sending.resolve();
          await accepted.promise;
          raise("NotificationFailed", {});
        },
      })),
    ],
  });
  onTestFinished(async () => {
    accepted.resolve();
    stop.abort();
    expect((await root.closed).status).toBe("success");
  });
  await root.ready;
  await root.run(migrate);
  const reply = root.run(handleAuth, {
    input: authRequest("sign-up/email", {
      name: "Ada",
      email: "ada@example.com",
      password: "safe-password-42",
    }),
    tags: requestHeaders(new Headers()),
  });
  await sending.promise;
  expect((await reply).status).toBe(200);
  accepted.resolve();
  await failed.promise;
});

test("releasing mail makes a fresh sender", async () => {
  const root = createScope({ tags });
  await root.ready;
  try {
    const first = await root.resolve(mail);
    root.release(mail);
    expect(await root.resolve(mail)).not.toBe(first);
  } finally {
    expect((await root.close({ graceful: true })).status).toBe("success");
  }
});

test("releasing database makes a fresh handle", async () => {
  const root = createScope({ tags });
  await root.ready;
  try {
    const first = await root.resolve(database);
    root.release(database);
    expect(await root.resolve(database)).not.toBe(first);
  } finally {
    expect((await root.close({ graceful: true })).status).toBe("success");
  }
});
