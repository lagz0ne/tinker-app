import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createScope } from "@tinker/core";
import { getMigrations } from "better-auth/db/migration";
import { afterEach, expect, test } from "vite-plus/test";

import {
  approveSignin,
  auth,
  authSettings,
  checkMcpToken,
  handleAuth,
  mcpCaller,
} from "~/components/auth-sqlite/index.server";
import {
  database,
  databaseBusyTimeout,
  databaseMigrationTimeout,
  databaseMigrationsFolder,
  databaseUrl,
  migrate,
} from "~/components/database-sqlite/index.server";
import { requestHeaders } from "~/components/requests/index.server";

const app = fileURLToPath(new URL("..", import.meta.url));

const origin = "http://localhost:4318";

const resource = `${origin}/mcp`;

const claude = "https://claude.ai/api/mcp/auth_callback";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** A migrated temp database, with auth configured for a real sign-in. */
async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), "tinker-auth-mcp-"));

  homes.push(home);

  const folder = join(home, "migrations");

  await mkdir(folder);

  for (const name of await readdir(join(app, "sqlite/migrations"))) {
    await writeFile(
      join(folder, name),
      await readFile(join(app, "sqlite/migrations", name), "utf8"),
    );
  }

  const root = createScope({
    tags: [
      databaseUrl(pathToFileURL(join(home, "app.db"))),
      databaseMigrationsFolder(folder),
      databaseBusyTimeout(20),
      databaseMigrationTimeout(10_000),
      authSettings({ origin, secret: "test-secret-with-at-least-thirty-two-letters" }),
    ],
  });

  await root.run(migrate);

  const db = await root.resolve(database);

  return { root, db };
}

type Sandbox = Awaited<ReturnType<typeof sandbox>>;

/** One request through the component's auth mount, as the route hands it over. */
function send(
  box: Sandbox,
  path: string,
  init: { body?: object; form?: Record<string, string>; cookie?: string } = {},
) {
  const headers = new Headers({ origin, cookie: init.cookie ?? "" });

  if (init.body) headers.set("content-type", "application/json");

  if (init.form) headers.set("content-type", "application/x-www-form-urlencoded");

  const body = init.body
    ? JSON.stringify(init.body)
    : init.form
      ? new URLSearchParams(init.form)
      : undefined;

  return box.root.run(handleAuth, {
    input: new Request(new URL(path, origin), { method: body ? "POST" : "GET", headers, body }),
    tags: requestHeaders(headers),
  });
}

function sessionCookie(response: Response) {
  return (
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith("better-auth.session_token="))
      ?.split(";")
      .at(0) ?? ""
  );
}

async function signUp(box: Sandbox, name: string) {
  const response = await send(box, "/api/auth/sign-up/email", {
    body: { name, email: `${name}@example.com`, password: "safe-password-42" },
  });

  const body = (await response.json()) as { user: { id: string } };

  return { id: body.user.id, cookie: sessionCookie(response) };
}

async function register(box: Sandbox, redirects: string[] = [claude], extra: object = {}) {
  const response = await send(box, "/api/auth/oauth2/register", {
    body: {
      ...extra,
      client_name: "Claude",
      redirect_uris: redirects,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  });

  return { response, body: (await response.json()) as { client_id: string } };
}

/** The authorize request a client sends, with PKCE S256 and the MCP resource. */
function authorizeQuery(clientId: string, scope = "mcp offline_access", state = "s1") {
  const verifier = randomBytes(32).toString("base64url");

  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: claude,
    scope,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource,
  });

  return { query, verifier };
}

/** The signed query the provider hands its login or consent page. */
async function pageQuery(box: Sandbox, query: URLSearchParams, cookie = "") {
  const response = await send(box, `/api/auth/oauth2/authorize?${query}`, { cookie });

  expect(response.status).toBe(302);

  const page = new URL(response.headers.get("location") ?? "", origin);

  return { page: page.pathname, oauth_query: page.search.slice(1) };
}

async function consent(box: Sandbox, cookie: string, oauth_query: string) {
  const response = await send(box, "/api/auth/oauth2/consent", {
    body: { accept: true, oauth_query },
    cookie,
  });

  return new URL(((await response.json()) as { url: string }).url);
}

/** The full flow for one signed-in person: register, authorize, consent, token. */
async function tokens(box: Sandbox, cookie: string, scope = "mcp offline_access") {
  const { body: client } = await register(box);

  const { query, verifier } = authorizeQuery(client.client_id, scope);

  const { page, oauth_query } = await pageQuery(box, query, cookie);

  expect(page).toBe("/consent");

  const back = await consent(box, cookie, oauth_query);

  expect(back.origin + back.pathname).toBe(claude);

  expect(back.searchParams.get("state")).toBe("s1");

  const response = await send(box, "/api/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      redirect_uri: claude,
      client_id: client.client_id,
      code_verifier: verifier,
      resource,
    },
  });

  expect(response.status).toBe(200);

  const body = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    scope: string;
  };

  return { ...body, clientId: client.client_id };
}

/** The route's part: read the request's parts in, and send a challenge back as the reply. */
async function check(box: Sandbox, authorization?: string) {
  const request = new Request(resource, {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });

  const answer = await box.root.run(checkMcpToken, {
    input: {
      authorizationHeader: request.headers.get("authorization"),
      dpopProofJwt: request.headers.get("dpop"),
      method: request.method,
      url: request.url,
    },
  });

  return {
    caller: answer.caller,
    response: answer.challenge
      ? new Response(JSON.stringify(answer.challenge.body), answer.challenge)
      : undefined,
  };
}

function claimsOf(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as Record<
    string,
    unknown
  >;
}

const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp"`;

test("the migration holds every table and column Better Auth asks for", async () => {
  const box = await sandbox();

  const { options } = await box.root.resolve(auth);

  const migrations = await getMigrations(options);

  expect(migrations.toBeCreated).toEqual([]);

  expect(migrations.toBeAdded).toEqual([]);

  await box.root.close({ graceful: true });
});

test("B1, B2: registration takes listed and loopback redirects and refuses the rest", async () => {
  const box = await sandbox();

  for (const redirects of [[claude], ["https://claude.com/api/mcp/auth_callback"]]) {
    const { response, body } = await register(box, redirects);

    expect(response.status, redirects[0]).toBe(201);

    expect(body.client_id).toEqual(expect.any(String));
  }

  // Better Auth takes a loopback http redirect only from a native client (RFC 8252 7.3).
  for (const redirects of [["http://127.0.0.1:5555/callback"], ["http://localhost/callback"]]) {
    const { response, body } = await register(box, redirects, { application_type: "native" });

    expect(response.status, redirects[0]).toBe(201);

    expect(body.client_id).toEqual(expect.any(String));
  }

  const web = await register(box, ["http://127.0.0.1:5555/callback"]);

  expect(web.response.status).toBe(400);

  expect(web.body).toMatchObject({ error: "invalid_redirect_uri" });

  const clients = () => box.db.reader.prepare(`SELECT id FROM "oauthClient"`).all().length;

  for (const redirects of [
    ["https://evil.example/cb"],
    [claude, "https://evil.example/cb"],
    ["http://127.0.0.1:5555/other"],
    ["http://evil.example:5555/callback"],
    [],
  ]) {
    const { response, body } = await register(box, redirects, { application_type: "native" });

    expect(response.status, redirects.join()).toBe(400);

    expect(body).toMatchObject({
      error: "invalid_redirect_uri",
      error_description: expect.any(String),
    });
  }

  const none = await send(box, "/api/auth/oauth2/register", {
    body: { client_name: "Claude", token_endpoint_auth_method: "none" },
  });

  expect(none.status).toBe(400);

  expect(await none.json()).toMatchObject({ error: "invalid_redirect_uri" });

  expect(clients()).toBe(4);

  // A signed-in person's own client goes through the same check.
  const { cookie } = await signUp(box, "ursa");

  const managed = await send(box, "/api/auth/oauth2/create-client", {
    body: { client_name: "Mine", redirect_uris: ["https://evil.example/cb"] },
    cookie,
  });

  expect(managed.status).toBe(400);

  expect(clients()).toBe(4);

  // An update may keep its redirect URIs, but may not move them off the list.
  const own = await send(box, "/api/auth/oauth2/create-client", {
    body: { client_name: "Mine", redirect_uris: [claude] },
    cookie,
  });

  expect(own.status).toBe(201);

  const { client_id } = (await own.json()) as { client_id: string };

  const moved = await send(box, "/api/auth/oauth2/update-client", {
    body: { client_id, update: { redirect_uris: ["https://evil.example/cb"] } },
    cookie,
  });

  expect(moved.status).toBe(400);

  expect(await moved.json()).toMatchObject({ error: "invalid_redirect_uri" });

  const renamed = await send(box, "/api/auth/oauth2/update-client", {
    body: { client_id, update: { client_name: "Still mine" } },
    cookie,
  });

  expect(renamed.status).toBe(200);

  expect(
    box.db.reader
      .prepare(`SELECT name, redirectUris FROM "oauthClient" WHERE clientId = ?`)
      .get(client_id),
  ).toEqual({ name: "Still mine", redirectUris: JSON.stringify([claude]) });

  await box.root.close({ graceful: true });
});

test("B3: the metadata names the MCP resource and this issuer, at the paths the app must route", async () => {
  const box = await sandbox();

  const issuer = `${origin}/api/auth`;

  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    const response = await send(box, path);

    expect(response.status, path).toBe(200);

    expect(await response.json()).toMatchObject({
      resource,
      authorization_servers: [issuer],
      scopes_supported: ["mcp"],
    });
  }

  for (const path of [
    "/.well-known/oauth-authorization-server/api/auth",
    "/api/auth/.well-known/oauth-authorization-server",
  ]) {
    const response = await send(box, path);

    expect(response.status, path).toBe(200);

    const metadata = (await response.json()) as Record<string, unknown>;

    expect(metadata).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      token_endpoint: `${issuer}/oauth2/token`,
      registration_endpoint: `${issuer}/oauth2/register`,
      scopes_supported: expect.arrayContaining(["mcp", "offline_access"]),
      code_challenge_methods_supported: ["S256"],
    });

    expect(metadata.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  }

  await box.root.close({ graceful: true });
});

test("B4, B5: the full OAuth flow gives a resource-bound JWT and a refresh token; the check names the caller", async () => {
  const box = await sandbox();

  const u = await signUp(box, "ursa");

  const issued = await tokens(box, u.cookie);

  expect(issued.refresh_token).toEqual(expect.any(String));

  expect(claimsOf(issued.access_token)).toMatchObject({
    aud: resource,
    iss: `${origin}/api/auth`,
    sub: u.id,
    azp: issued.clientId,
  });

  const answer = await check(box, `Bearer ${issued.access_token}`);

  expect(answer).toEqual({
    caller: { userId: u.id, clientId: issued.clientId, scopes: ["mcp", "offline_access"] },
    response: undefined,
  });

  await box.root.close({ graceful: true });
});

test("B6: no token, garbage, expired, or a token for another audience answers the RFC 9728 401", async () => {
  const box = await sandbox();

  const u = await signUp(box, "ursa");

  const issued = await tokens(box, u.cookie);

  const instance = await box.root.resolve(auth);

  const expired = await instance.api.signJWT({
    body: {
      payload: {
        ...claimsOf(issued.access_token),
        iat: Math.floor(Date.now() / 1000) - 7200,
        exp: Math.floor(Date.now() / 1000) - 3600,
      },
    },
  });

  // The jwt plugin's own session token: signed with the same keys, for the issuer, not the resource.
  const session = (await (await send(box, "/api/auth/token", { cookie: u.cookie })).json()) as {
    token: string;
  };

  expect(claimsOf(session.token).aud).not.toBe(resource);

  const [head, , signature] = issued.access_token.split(".");

  const forged = `${head}.${Buffer.from(JSON.stringify({ ...claimsOf(issued.access_token), sub: "someone-else" })).toString("base64url")}.${signature}`;

  for (const [name, authorization] of [
    ["none", undefined],
    ["garbage", "Bearer not-a-token"],
    ["no scheme", issued.access_token],
    ["expired", `Bearer ${expired.token}`],
    ["other audience", `Bearer ${session.token}`],
    ["forged", `Bearer ${forged}`],
    ["refresh token", `Bearer ${issued.refresh_token}`],
  ] as const) {
    const answer = await check(box, authorization);

    expect(answer.caller, name).toBeUndefined();

    expect(answer.response?.status, name).toBe(401);

    expect(answer.response?.headers.get("www-authenticate"), name).toBe(challenge);

    expect(await answer.response?.json(), name).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000 },
      id: null,
    });
  }

  await box.root.close({ graceful: true });
});

test("B7: a token without the mcp scope answers 403 insufficient_scope", async () => {
  const box = await sandbox();

  const u = await signUp(box, "ursa");

  const issued = await tokens(box, u.cookie, "offline_access");

  expect(issued.scope).toBe("offline_access");

  expect(claimsOf(issued.access_token).aud).toBe(resource);

  const answer = await check(box, `Bearer ${issued.access_token}`);

  expect(answer.caller).toBeUndefined();

  expect(answer.response?.status).toBe(403);

  expect(answer.response?.headers.get("www-authenticate")).toMatch(
    /^Bearer error="insufficient_scope", scope="mcp", resource_metadata="http:\/\/localhost:4318\/\.well-known\/oauth-protected-resource\/mcp"/,
  );

  await box.root.close({ graceful: true });
});

test("A15: a code sign-in from the OAuth login page goes on to the OAuth redirect", async () => {
  const box = await sandbox();

  const u = await signUp(box, "ursa");

  const { body: client } = await register(box);

  const approver = { userId: u.id, clientId: "client-ursa", scopes: ["mcp"] };

  /** A browser with no session walks the login page with a code; the finish's reply. */
  async function walk(state: string) {
    const { query } = authorizeQuery(client.client_id, "mcp offline_access", state);

    const { page, oauth_query } = await pageQuery(box, query);

    expect(page).toBe("/signin");

    const started = await send(box, "/api/auth/signin/code", { body: { oauth_query } });

    const { user_code } = (await started.json()) as { user_code: string };

    const device =
      started.headers
        .getSetCookie()
        .find((value) => value.startsWith("tinker_device="))
        ?.split(";")
        .at(0) ?? "";

    const approved = await box.root.run(approveSignin, {
      input: { code: user_code },
      tags: mcpCaller(approver),
    });

    expect(approved.text).toContain(`"Allow access" for Claude`);

    const finished = await send(box, "/api/auth/signin/code/finish", {
      body: { oauth_query },
      cookie: device,
    });

    expect(finished.status).toBe(200);

    const cookie = sessionCookie(finished);

    expect(cookie).not.toBe("");

    const body = (await finished.json()) as { redirect: boolean; url: string };

    expect(body.redirect).toBe(true);

    return { cookie, url: new URL(body.url, origin) };
  }

  // The first time, Better Auth's provider sends the new session to its consent page.
  const first = await walk("s1");

  expect(first.url.pathname).toBe("/consent");

  const back = await consent(box, first.cookie, first.url.search.slice(1));

  expect(back.origin + back.pathname).toBe(claude);

  expect(back.searchParams.get("code")).toEqual(expect.any(String));

  expect(back.searchParams.get("state")).toBe("s1");

  // With the consent kept, the finish answers the client's redirect URI with a code.
  const second = await walk("s2");

  expect(second.url.origin + second.url.pathname).toBe(claude);

  expect(second.url.searchParams.get("code")).toEqual(expect.any(String));

  expect(second.url.searchParams.get("state")).toBe("s2");

  await box.root.close({ graceful: true });
});

test("a start with a forged oauth_query is refused before any code is made", async () => {
  const box = await sandbox();

  const { body: client } = await register(box);

  const { query } = authorizeQuery(client.client_id);

  const { oauth_query } = await pageQuery(box, query);

  const forged = oauth_query.replace("state=s1", "state=s9");

  const response = await send(box, "/api/auth/signin/code", { body: { oauth_query: forged } });

  expect(response.status).toBe(400);

  expect(await response.json()).toMatchObject({ error: "invalid_signature" });

  expect(box.db.reader.prepare(`SELECT id FROM "deviceCode"`).all()).toEqual([]);

  await box.root.close({ graceful: true });
});
