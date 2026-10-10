import { backendStop, env, requestStop } from "@tinker/start/server";
import { openSync } from "@tinker/start/testing";
import { handleAuth } from "@tinker-start-scaffold/testing";
import { proofDatabase, proofMail, requestHeaders } from "@tinker-start-scaffold/testing";
import { test, expect } from "vite-plus/test";
import { createScope } from "@tinker/core";
import { auth, migrate, saveProfile } from "@tinker-start-scaffold/backend";

const tags = env({
  DATABASE_URL: "postgres://proof",
  PUBLIC_ORIGIN: "http://localhost:4318",
  AUTH_SECRET: "test-secret-with-at-least-thirty-two-letters",
});

const account = 'event: account\ndata: {"kind":"account-change"}\n\n';

function authRequest(path: string, body: object, cookie = "") {
  return new Request(`http://localhost:4318/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:4318", cookie },
    body: JSON.stringify(body),
  });
}

function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";").at(0))
    .join("; ");
}

/** A signed-up account, with the cookie of its first session and its account ID. */
async function signUp(root: ReturnType<typeof createScope>, name: string) {
  const response = await root.run(handleAuth, {
    input: authRequest("sign-up/email", {
      name,
      email: `${name}@example.com`,
      password: "safe-password-42",
    }),
    tags: requestHeaders(new Headers()),
  });
  const body = (await response.json()) as { user: { id: string } };
  return { id: body.user.id, cookie: cookieOf(response) };
}

/** A second session of an account that already exists: one more device. */
async function signIn(root: ReturnType<typeof createScope>, name: string) {
  const response = await root.run(handleAuth, {
    input: authRequest("sign-in/email", {
      email: `${name}@example.com`,
      password: "safe-password-42",
    }),
    tags: requestHeaders(new Headers()),
  });
  return cookieOf(response);
}

/** A held sync stream for one device, past its greeting. */
async function openStream(root: ReturnType<typeof createScope>, accountId: string, cookie: string) {
  const session = root.createSession({ tags: requestHeaders(new Headers({ cookie })) });
  const reader = (
    await session.run(openSync, {
      input: { cursor: { public: 0, private: { accountId, revision: 0 } } },
    })
  ).getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
  return { session, reader };
}

const text = async (read: Promise<ReadableStreamReadResult<Uint8Array>>) => {
  const { value } = await read;
  return value === undefined ? "" : new TextDecoder().decode(value);
};

/** Runs one test on a fresh root with the real auth library and a PGlite database. */
async function withRoot(run: (root: ReturnType<typeof createScope>) => Promise<void>) {
  const stop = new AbortController();
  const root = createScope({
    signal: stop.signal,
    tags: [tags, backendStop(stop.signal), requestStop(stop.signal)],
    presets: [proofDatabase, proofMail],
  });
  await root.ready;
  try {
    await root.run(migrate);
    await run(root);
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
}

test("sign-out closes the account's open stream with the account frame", async () => {
  await withRoot(async (root) => {
    const ada = await signUp(root, "Ada");
    const { session, reader } = await openStream(root, ada.id, ada.cookie);
    const held = reader.read();
    await root.run(handleAuth, {
      input: authRequest("sign-out", {}, ada.cookie),
      tags: requestHeaders(new Headers({ cookie: ada.cookie })),
    });
    expect(await text(held)).toBe(account);
    expect((await session.close({ graceful: true })).status).toBe("success");
  });
});

test("revoking another device closes only that device's stream; this device's stream stays open", async () => {
  await withRoot(async (root) => {
    const phone = await signUp(root, "Ada");
    const laptop = { id: phone.id, cookie: await signIn(root, "Ada") };
    const phoneStream = await openStream(root, phone.id, phone.cookie);
    const laptopStream = await openStream(root, laptop.id, laptop.cookie);
    const phoneHeld = phoneStream.reader.read();
    const laptopHeld = laptopStream.reader.read();
    await root.run(handleAuth, {
      input: authRequest("revoke-other-sessions", {}, laptop.cookie),
      tags: requestHeaders(new Headers({ cookie: laptop.cookie })),
    });
    expect(await text(phoneHeld)).toBe(account);
    await root.run(saveProfile, {
      input: { executionId: crypto.randomUUID(), profile: { name: "Ada laptop" } },
      tags: requestHeaders(new Headers({ cookie: laptop.cookie })),
    });
    expect(await text(laptopHeld)).toContain("event: changes");
    await laptopStream.reader.cancel();
    await phoneStream.session.close({ graceful: true });
    await laptopStream.session.close({ graceful: true });
  });
});

test("a session the server deletes closes its account's stream", async () => {
  await withRoot(async (root) => {
    const ada = await signUp(root, "Ada");
    const { session, reader } = await openStream(root, ada.id, ada.cookie);
    const held = reader.read();
    const ctx = await (await root.resolve(auth)).$context;
    const [only] = await ctx.internalAdapter.listSessions(ada.id);
    await ctx.internalAdapter.deleteSession(only!.token);
    expect(await text(held)).toBe(account);
    expect((await session.close({ graceful: true })).status).toBe("success");
  });
});

test("deleting a user closes that account's open stream", async () => {
  await withRoot(async (root) => {
    const ada = await signUp(root, "Ada");
    const { session, reader } = await openStream(root, ada.id, ada.cookie);
    const held = reader.read();
    const ctx = await (await root.resolve(auth)).$context;
    await ctx.internalAdapter.deleteUser(ada.id);
    expect(await text(held)).toBe(account);
    expect((await session.close({ graceful: true })).status).toBe("success");
  });
});
