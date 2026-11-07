import { afterEach, expect, test } from "bun:test";

import { createScope, data, operation, resource, tag } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { z } from "zod";

import { hook } from "~/components/protocol";
import { remoteData } from "~/components/remote-data";
import { routes } from "~/components/requests/index.server";
import { rpc } from "~/components/rpc";

import { createWs, listen } from "./support/ws";

// Duke's stress case, whole: a public and a signed transport, EACH ON ITS OWN BASE (two
// SSE bases), on both sides. The signed side sends a short access token; when it expires, the
// client uses the refresh token (OAuth 2.0, RFC 6749 s6) and tries once more. One trace links
// the call, the refresh and the retry, across both transports.

const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---- shared definitions
const tokensOut = z.object({
  kind: z.literal("in"),
  who: z.string(),
  access: z.string(),
  refresh: z.string(),
});

const auth = rpc({
  "auth.status": {
    input: z.null(),
    output: z.discriminatedUnion("kind", [tokensOut, z.object({ kind: z.literal("out") })]),
  },
  "auth.refresh": {
    input: z.object({ refresh: z.string() }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("in"), access: z.string() }),
      z.object({ kind: z.literal("out") }),
    ]),
  },
});

const notes = data({ initial: [] as string[] });
const board = remoteData({ notes });
const api = rpc({ "note.add": { input: z.string(), output: z.number() } });

// ---- the server: two transports, one route table each.
async function boot(ttl: number) {
  const sessions = new Map<string, string>(); // cookie sid -> who
  const access = new Map<string, { who: string; until: number }>();
  const refreshes = new Map<string, string>(); // refresh token -> who
  let n = 0;
  const grant = (who: string) => {
    const token = `a${++n}`;
    access.set(token, { who, until: Date.now() + ttl });
    return token;
  };
  const user = tag<string>({ label: "user" });
  const status = operation({
    label: "auth.status.do",
    input: z.null(),
    depends: { req: routes.request.required },
    run: ({ req }) => {
      const who = sessions.get(/sid=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? "");
      if (!who) return { kind: "out" as const };
      const refresh = `r${++n}`;
      refreshes.set(refresh, who);
      return { kind: "in" as const, who, access: grant(who), refresh };
    },
  });
  const refresh = operation({
    label: "auth.refresh.do",
    input: z.object({ refresh: z.string() }),
    run: (_, { input }) => {
      const who = refreshes.get(input.refresh);
      return who ? { kind: "in" as const, access: grant(who) } : { kind: "out" as const };
    },
  });
  const whoOf = (meta: Record<string, string>) =>
    access.get(/^Bearer (.+)$/.exec(meta.authorization ?? "")?.[1] ?? "");
  /** RFC 6750: an unknown token asks for sign-in; an old one says it expired. */
  const bearer = operation({
    label: "bearer",
    input: hook.start,
    run: async (_, { input }) => {
      const held = whoOf(input.meta);
      if (!held) return input.refuse({ signIn: true });
      if (held.until < Date.now()) return input.refuse({ expired: true });
      return { tags: [user(held.who)] };
    },
  });
  const add = operation({
    label: "note.add.do",
    input: z.string(),
    depends: { list: notes.controller, me: user.required },
    run: ({ list, me }, { input }) => (
      list.set([...list.get(), `${me}: ${input}`]),
      list.get().length
    ),
  });
  const publicWs = createWs();
  const signedWs = createWs();
  const spans: Observe.Span[] = [];
  const server = createScope({
    observe: { export: (x) => void spans.push(x) },
    capsules: [
      auth({ implement: { "auth.status": status, "auth.refresh": refresh } }),
      board({ serve: true, onStart: [bearer] }),
      api({ onStart: [bearer], implement: { "note.add": add } }),
      publicWs.server({ path: "/public", services: [auth] }),
      signedWs.server({ path: "/api", services: [board, api] }),
    ],
  });
  await server.ready;
  closers.push(() => server.close());
  const { bun, url } = listen(server, [publicWs.server, signedWs.server]);
  closers.push(() => bun.stop(true));

  return { url, sessions, refreshes, spans };
}

// ---- the client: two transports. Tokens live in a client cell.
const held = data<{ access: string; refresh: string } | null>({ initial: null });

/**
 * Where the tokens live is picked by usage, not by `held`. The transport runs `meta` and `renew`
 * inside calls that carry a `signal`: each is a child session (ADR 0090), and a plain
 * `held.controller` write would stay there. A `scope`-target resource takes the controller at
 * the root, so every write through it lands there (Core 0.11.0).
 */
const tokens = resource({
  label: "tokens",
  target: "scope",
  depends: { held: held.controller },
  factory: ({ held }) => held,
});

const counts = { status: 0, refresh: 0 };

/** Before each signed request: the access token, after one auth check if there is none. */
const credentials = operation({
  label: "credentials",
  depends: { status: auth["auth.status"], tokens },
  run: async ({ status, tokens }): Promise<Record<string, string>> => {
    if (!tokens.get()) {
      counts.status++;
      const now = await status.run({ input: null });
      if (now.kind === "in") tokens.set({ access: now.access, refresh: now.refresh });
    }
    const now = tokens.get();
    return now ? { authorization: `Bearer ${now.access}` } : {};
  },
});

/** On a refusal (OkHttp's Authenticator): expired -> refresh; true means try once more. */
const renew = operation({
  label: "renew",
  input: z.object({ payload: z.unknown(), sent: z.record(z.string(), z.string()) }),
  depends: { refresh: auth["auth.refresh"], tokens },
  run: async ({ refresh, tokens }, { input }) => {
    const now = tokens.get();
    if (now && input.sent.authorization !== `Bearer ${now.access}`) return true; // renewed meanwhile
    if (!now || !Object(input.payload).expired) return (tokens.set(null), Boolean(now)); // sign in again, once
    counts.refresh++;
    const next = await refresh.run({ input: { refresh: now.refresh } });
    tokens.set(next.kind === "in" ? { ...now, access: next.access } : null);

    return true;
  },
});

async function client(url: string, sid: string) {
  const headers = { cookie: `sid=${sid}` };
  const publicWs = createWs();
  const signedWs = createWs();
  const spans: Observe.Span[] = [];
  const scope = createScope({
    observe: { export: (x) => void spans.push(x) },
    capsules: [
      publicWs.client({ url: `${url}/public`, headers }),
      auth({ remote: publicWs.client }),
      signedWs.client({ url: `${url}/api`, headers, meta: credentials, renew }),
      board({ read: signedWs.client }),
      api({ remote: signedWs.client }),
    ],
  });
  await scope.ready;
  closers.push(() => scope.close());

  return { scope, spans };
}

test("each transport on its own path: /public answers the auth check, /api the rest", async () => {
  const { url, sessions } = await boot(60_000);
  sessions.set("s1", "duke");
  const { scope } = await client(url, "s1");

  expect(await scope.run(api["note.add"], { input: "hi" })).toBe(1);
  await tick();
  expect(scope.resolve(board.notes).get()).toEqual(["duke: hi"]);
  // The signed path has no auth.status; the public path has no note.add.
  const first = async (path: string, a: string, t: string) => {
    const socket = new WebSocket(`${url}${path}`);
    const got = await new Promise<{ e?: number }>((done) => {
      socket.onopen = () => socket.send(JSON.stringify([{ i: 1, a, t }]));
      socket.onmessage = (e) => done(JSON.parse(String(e.data))[0]);
    });

    socket.close();
    return got.e;
  };
  expect(await first("/api", "auth.status", "null")).toBe(404);
  expect(await first("/public", "note.add", '"x"')).toBe(404);
});

test("the access token expires: one refresh, the call tries once more and works", async () => {
  const { url, sessions } = await boot(150);
  sessions.set("s2", "ann");
  const { scope } = await client(url, "s2");
  const before = { ...counts };

  expect(await scope.run(api["note.add"], { input: "one" })).toBe(1);
  await tick(200); // the access token is now old
  expect(await scope.run(api["note.add"], { input: "two" })).toBe(2);
  expect([counts.status - before.status, counts.refresh - before.refresh]).toEqual([0, 1]);
});

test("10 calls refused at once: ONE refresh (single flight); all 10 work", async () => {
  const { url, sessions } = await boot(150);
  sessions.set("s3", "bo");
  const { scope } = await client(url, "s3");
  await scope.run(api["note.add"], { input: "warm" });
  await tick(200);
  const before = counts.refresh;
  const all = await Promise.all(
    Array.from({ length: 10 }, (_, i) => scope.run(api["note.add"], { input: `n${i}` })),
  );

  expect(all.sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  expect(counts.refresh - before).toBe(1);
});

test("signed out (session and refresh token gone): the retry asks to sign in, and that is the answer", async () => {
  const { url, sessions, refreshes } = await boot(150);
  sessions.set("s4", "cy");
  const { scope } = await client(url, "s4");
  await scope.run(api["note.add"], { input: "warm" });
  sessions.delete("s4");
  refreshes.clear();
  await tick(200);
  const error = await scope.run(api["note.add"], { input: "late" }).then(
    () => null,
    (e: unknown) => e,
  );

  expect(api.fault.is(error) && [error.fault, error.payload]).toEqual([
    "refused",
    { signIn: true },
  ]);
});

test("one trace: the call, its refused try, the refresh on /public, the retry on /api", async () => {
  const server = await boot(150);
  server.sessions.set("s5", "dee");
  const { scope, spans } = await client(server.url, "s5");
  await scope.run(api["note.add"], { input: "warm" });
  await tick(200);
  spans.length = 0;
  server.spans.length = 0;
  await scope.run(api["note.add"], { input: "after" });
  await tick(50);
  const call = spans.find((x) => x.name === "note.add")!;
  const trace = call.traceId;
  const mine = (list: Observe.Span[]) => list.filter((x) => x.traceId === trace).map((x) => x.name);
  const count = (names: string[], name: string) => names.filter((n) => n === name).length;
  const client_ = mine(spans);
  const server_ = mine(server.spans);

  // Client: two credentials runs, one renew, one refresh call, three sends (try, refresh, retry).
  expect([
    count(client_, "credentials"),
    count(client_, "renew"),
    count(client_, "auth.refresh"),
    count(client_, "ws.send"),
  ]).toEqual([2, 1, 1, 3]);
  // Server: three requests in the same trace; the first is refused, the retry runs the op.
  expect([
    count(server_, "ws.serve"),
    count(server_, "bearer"),
    count(server_, "auth.refresh.do"),
    count(server_, "note.add.do"),
  ]).toEqual([3, 2, 1, 1]);
  // The refresh is a child of renew, which is a child of the call (not a new trace).
  const byId = new Map(spans.map((x) => [x.spanId, x]));
  const up = (x: Observe.Span | undefined): string[] =>
    x ? [x.name, ...up(byId.get(x.parentSpanId ?? ""))] : [];
  expect(up(spans.find((x) => x.name === "auth.refresh"))).toContain("renew");
  expect(up(spans.find((x) => x.name === "renew"))).toContain("note.add");
  // Every server span of this call sits under a client ws.send span.
  const sends = new Set(spans.filter((x) => x.name === "ws.send").map((x) => x.spanId));
  const roots = server.spans
    .filter((x) => x.traceId === trace && x.name === "ws.serve")
    .map((x) => x.parentSpanId);
  expect(roots.every((p) => sends.has(p ?? ""))).toBe(true);
});
