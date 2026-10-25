import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { createAuthClient } from "better-auth/react";
import { test, expect } from "vite-plus/test";

import { authStartup } from "~/components/auth/index.server";
import { authSettings } from "~/components/auth/index.server";
import { openSync } from "~/components/auth/index.server";
import { migrate, databaseUrl } from "~/components/database/index.server";
import { backendStop as requestHostStop } from "~/components/requests";
import { startRequests } from "~/components/requests";
import { backendStop, requestStop } from "~/components/requests";
import { loadSnapshot, checkAccount } from "~/components/sync/client/events";
import { refreshAccount, receiveMessage } from "~/components/sync/client/events";
import { syncClient } from "~/components/sync/client/sync";
import { tabStop } from "~/components/sync/client/tab";
import { snapshotSource } from "~/components/sync/functions";
import { bootstrapSlot, readAccountSlot } from "~/components/sync/index.server";
import { syncStartup } from "~/components/sync/slots";

import { readAccount } from "@/demo/backend/auth.server";
import { incrementCounter } from "@/demo/backend/counter.server";
import { bootstrap } from "@/demo/backend/sync.server";
import { authClient, signIn } from "@/frontend/auth-actions";

import { clientBindings } from "./presets";
import { handleAuth } from "./presets";
import { proofDatabase, proofMail, requestHeaders } from "./presets";
import { write } from "./write-boundary";

const requestBindings = requestHostStop(new AbortController().signal);

const settings = [
  [bootstrapSlot(bootstrap), readAccountSlot(readAccount)],
  databaseUrl(new URL("postgres://proof")),
  authSettings({
    origin: "http://localhost:4318",
    secret: "test-secret-with-at-least-thirty-two-letters",
  }),
];

test("a stream checks the session once at open, and a save does not check it again", async () => {
  const stop = new AbortController();
  const root = createScope({
    extensions: [startRequests, authStartup],
    signal: stop.signal,
    tags: [
      requestBindings,
      [
        [
          settings,
          backendStop(stop.signal),
          requestStop(stop.signal),
          requestHeaders(new Headers()),
        ],
      ],
    ],
    presets: [proofDatabase, proofMail],
    observe: { history: 100 },
  });
  await root.ready;
  try {
    await root.run(migrate);
    await write(root, incrementCounter, { input: { executionId: crypto.randomUUID() } });

    const response = await root.run(openSync, { input: { cursor: { public: 0, private: null } } });
    const reader = response.getReader();
    await reader.read();
    await reader.read();

    const waiting = reader.read();
    await write(root, incrementCounter, { input: { executionId: crypto.randomUUID() } });
    await waiting;

    expect(root.spans().filter((span) => span.name === "sync.liveAccount")).toHaveLength(1);
    await reader.cancel();
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("a signed-out private redirect loads one snapshot across separate renders", async () => {
  const stop = new AbortController();
  let loads = 0;

  const source = preset(snapshotSource, () => ({
    async load() {
      loads += 1;
      return { public: { stream: "public" as const, revision: 0, value: 0 }, private: null };
    },
    async account() {
      return null;
    },
  }));

  const page = createScope({
    signal: stop.signal,
    extensions: [syncStartup],
    tags: [clientBindings, tabStop(stop.signal)],
    presets: [source],
  });
  const redirected = createScope({
    signal: stop.signal,
    extensions: [syncStartup],
    tags: [clientBindings, tabStop(stop.signal)],
    presets: [source],
  });

  await Promise.all([page.ready, redirected.ready]);
  try {
    const account = await page.run(checkAccount);
    if (account !== null) throw account;
    await redirected.run(loadSnapshot);
    expect(loads).toBe(1);
  } finally {
    stop.abort();
    expect((await page.closed).status).toBe("success");
    expect((await redirected.closed).status).toBe("success");
  }
});

test("sign-in, an old stream account event, and route loads fetch one signed-in snapshot", async () => {
  const stop = new AbortController();
  let cookie = "";
  let loads = 0;
  const sent = Promise.withResolvers<void>();
  const allowed = Promise.withResolvers<void>();

  const server = createScope({
    extensions: [startRequests, authStartup],
    signal: stop.signal,
    tags: [requestBindings, [settings]],
    presets: [proofDatabase, proofMail],
  });
  await server.ready;
  await server.run(migrate);

  const browser = createScope({
    signal: stop.signal,
    extensions: [syncStartup],
    tags: [clientBindings, tabStop(stop.signal)],
    presets: [
      preset(authClient, async () =>
        createAuthClient({
          baseURL: "http://localhost:4318",
          fetchOptions: {
            customFetchImpl: async (url, init) => {
              sent.resolve();
              await allowed.promise;
              const response = await server.run(handleAuth, {
                input: new Request(url, init),
                tags: requestHeaders(new Headers({ cookie })),
              });
              cookie = response.headers
                .getSetCookie()
                .map((value) => value.split(";").at(0))
                .join("; ");
              return response;
            },
          },
        }),
      ),
      preset(snapshotSource, () => ({
        async load() {
          loads += 1;
          return server.run(bootstrap, { tags: requestHeaders(new Headers({ cookie })) });
        },
        async account() {
          return server.run(readAccount, { tags: requestHeaders(new Headers({ cookie })) });
        },
      })),
    ],
  });
  await browser.ready;
  try {
    const client = browser.resolve(syncClient);
    const oldVersion = client.capture().version;

    const signingIn = browser.run(signIn, {
      input: {
        mode: "signup",
        name: "Ada",
        email: "ada@example.com",
        password: "safe-password-42",
      },
    });

    await sent.promise;
    const reconnect = browser.run(refreshAccount);
    const route = browser.run(loadSnapshot);
    allowed.resolve();
    await Promise.all([signingIn, reconnect, route]);

    browser.run(receiveMessage, {
      input: { message: { kind: "account-change" }, version: oldVersion },
    });

    await browser.run(refreshAccount);
    await Promise.all([browser.run(loadSnapshot), browser.run(loadSnapshot)]);
    expect(loads).toBe(1);
  } finally {
    allowed.resolve();
    stop.abort();
    expect((await browser.closed).status).toBe("success");
    expect((await server.closed).status).toBe("success");
  }
});

test("a private route check clears cached records after another tab signs out", async () => {
  const stop = new AbortController();
  let cookie = "";

  const server = createScope({
    extensions: [startRequests, authStartup],
    signal: stop.signal,
    tags: [requestBindings, [settings]],
    presets: [proofDatabase, proofMail],
  });

  const browser = createScope({
    signal: stop.signal,
    extensions: [syncStartup],
    tags: [clientBindings, tabStop(stop.signal)],
    presets: [
      preset(snapshotSource, () => ({
        async load() {
          return server.run(bootstrap, { tags: requestHeaders(new Headers({ cookie })) });
        },
        async account() {
          return server.run(readAccount, { tags: requestHeaders(new Headers({ cookie })) });
        },
      })),
    ],
  });

  await Promise.all([server.ready, browser.ready]);
  try {
    await server.run(migrate);

    const response = await server.run(handleAuth, {
      tags: requestHeaders(new Headers()),
      input: new Request("http://localhost:4318/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:4318" },
        body: JSON.stringify({
          name: "Ada",
          email: "ada@example.com",
          password: "safe-password-42",
        }),
      }),
    });
    cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";").at(0))
      .join("; ");

    const loaded = await browser.run(loadSnapshot);
    expect(loaded.private?.profile.name).toBe("Ada");

    await server.run(handleAuth, {
      tags: requestHeaders(new Headers({ cookie })),
      input: new Request("http://localhost:4318/api/auth/sign-out", {
        method: "POST",
        headers: { cookie, origin: "http://localhost:4318" },
      }),
    });
    cookie = "";

    expect(await browser.run(checkAccount)).toBeNull();
    expect(browser.resolve(syncClient).snapshot().private).toBeNull();
    expect((await browser.run(loadSnapshot)).private).toBeNull();
  } finally {
    stop.abort();
    expect((await browser.closed).status).toBe("success");
    expect((await server.closed).status).toBe("success");
  }
});
