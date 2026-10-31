# MCP server and sign-in with a code

Date: 2026-10-31. Status: accepted.
Asked by: Hedl on Tinker, gaps TG1 (#40) and TG4 (#43).
Duke, 2026-10-26: no workarounds in Hedl;
a Tinker gap is fixed in Tinker.

## Context

Hedl ports obelisk (`lagz0ne/obelisk` at `000f8c7`).
Obelisk serves 78 MCP tools at `/mcp`
and signs people in with a one-time code.

What obelisk does today:

- `/mcp`: POST only (GET gets 405).
  A new MCP server and transport per call,
  stateless, JSON replies
  (`sessionIdGenerator: undefined`,
  `enableJsonResponse: true`).
- OAuth for MCP with the MCP SDK router:
  client registration (DCR), PKCE,
  protected resource metadata (RFC 9728),
  tokens bound to the `/mcp` resource.
  Redirects allowed: the two Claude
  callbacks and loopback `/callback`.
  Scopes: `obelisk`, `offline_access`.
- A tool error is a reply, not a crash:
  `isError: true`, text `Not done: <why>`.
- Sign-in with a code, RFC 8628 turned around:
  the browser asks for a code and keeps
  the other half in an httpOnly cookie.
  The owner sends the code to Claude.
  Claude approves it with the MCP tool
  `approve_signin`. Only that browser
  signs in. The OAuth "Allow access" page
  has the same "Allow with a code" button.
- Codes: 8 letters `XXXX-XXXX` from
  `BCDFGHJKLMNPQRSTVWXZ` (RFC 8628 6.1),
  10 minutes, one use, case and dash
  do not matter. At most 50 wait at once.
  10 wrong codes in 15 minutes lock approvals.
- `list_signins` shows waiting codes and
  code sign-ins; `end_signin` ends one.

## Precedent

- RFC 8628 (device authorization grant).
- RFC 9728 (protected resource metadata),
  RFC 8707 (resource indicators), OAuth 2.1.
- Better Auth 1.7.7, the auth library the
  SQLite set already runs:
  - `deviceAuthorization` plugin:
    the `deviceCode` table, user codes,
    one-use redeem (`redeemDeviceCode`).
  - `@better-auth/mcp` 1.7.7: `mcp()` is its
    OAuth 2.1 provider set up for MCP.
    It serves RFC 9728 metadata and binds
    tokens to the MCP resource.
    `createMcpProtectedRequestHandler`
    checks a token on a web `Request` and
    answers 401 with the RFC 9728 challenge.
  - `jwt()` signs the access tokens.
- The official `@modelcontextprotocol/sdk`:
  the web-standard Streamable HTTP server
  transport in stateless mode.

## Decision

Two parts, each in the component that owns it.

### `auth-sqlite` grows (TG4, and OAuth for TG1)

Better Auth owns one instance, so its plugins
sit in `auth-sqlite`:

- `jwt()` and `mcp()`, with DCR on and the
  redirect allowlist checked at every client
  write (register, create, update).
  A loopback redirect needs
  `application_type: "native"`: Better Auth
  follows RFC 8252 7.3 there.
  Claude Code and obelisk's `mcp-run.mjs`
  send no `application_type`, and Better
  Auth 1.7.7 then says "web" and refuses.
  1.7.7 has no option to change that
  default, so the register hook sets
  "native" when every redirect is loopback
  and no type is given. An explicit "web"
  with a loopback redirect is still refused.
- `deviceAuthorization()` with obelisk's code
  rules. Its public `/device*` routes are off.
  The component owns three routes instead:
  start (sets the httpOnly cookie), state,
  and finish (one session, then the cookie
  goes). Finish sets the session cookie
  through Better Auth, so a code sign-in
  started from the OAuth login page goes on
  to the OAuth redirect.
- New operations: `checkMcpToken` (check the
  bearer token; give the caller or the 401
  challenge), `approveSignin`, `listSignins`,
  `endSignin`. The approver is the caller
  (the `mcpCaller` tag): the browser signs in
  as the person who approved.
- `checkMcpToken` takes the request's parts
  as plain values and gives the challenge as
  plain data (status, headers, body).
  The route reads its `Request` and sends the
  `Response`: only `handleAuth` is a named
  protocol exception (ADR 0103).
- `listSignins` hides the code of a waiting
  code that the caller did not approve.
  Obelisk has one owner; Tinker has many users.
- Tables in one new `.sql` migration, in
  Better Auth 1.7.7's own SQLite shape.

New tag: `authMcp`, with defaults:

```ts
authMcp({
  path: "/mcp",
  scopes: ["mcp", "offline_access"],
  redirects: [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
  ],
  loopback: true,
});
```

### `mcp`, a new component (TG1)

- No auth inside. The app checks the token
  with its auth set, then hands the request
  and the caller's tags to `handleMcp`.
  So one `mcp` serves the SQLite set now
  and the Postgres set later.
- `handleMcp`: ADR 0103's protocol exception,
  as `handleAuth`. Web `Request` in,
  `Response` out. POST only.
  A new SDK server and stateless transport
  per request.
- Tools are data in the `mcpTools` tag:
  name, title, description, hints, the zod
  input, and the Core operation to run.
- Each tool call is one Core run, so one span.
  The raw arguments go in as `rawInput`;
  the operation's parse is the only parse.
  The tool list shows that same zod input
  as JSON Schema.
- Errors: a managed error (with a `kind`)
  becomes `isError: true` and
  `Not done: <message>`. Bad input names
  the bad fields. Any other error is logged,
  and the reply says the tool failed,
  with no detail.
- Changed while building (2026-10-31):
  an operation body cannot run an operation
  it picks at run time; only a scope verb
  can. So the component also ships the
  `mcpRuns` extension. The app installs it
  on the root, beside `startRequests`.
  Its run hook answers each `mcp.tool` call:
  it runs the tool with `event.settle`
  in the caller's layer, so the caller's
  tags reach the tool. The tool's span sits
  under one `mcp.tool` span, under
  `handleMcp`. Without the extension,
  `mcp.tool` raises `McpNotInstalled`.
- The managed error with a message is
  `Refused: { message }`. Other managed
  errors (such as `MissingTag`) say only
  that the tool failed.
- `mcp` requires only `errors`: it uses
  nothing from `requests`.
- Body cap: `mcpServer.maxBody`, default
  2 000 000 bytes, as obelisk's
  `express.json({ limit: "2mb" })`. The SDK
  1.32.2 transport reads the body under
  `maxRequestBodySize`: a Content-Length
  over it, or a stream past it, gets 413;
  bad JSON gets its -32700 reply.
- A tool row's `input` must be the same
  object as its operation's `input`, so
  the list cannot drift from the parse.

`mcpServer` tag: `{ name, version, instructions? }`.

## Why not

- The MCP SDK's own OAuth router (obelisk):
  it is Express only, and it would be a
  second user and token store beside
  Better Auth.
- Better Auth's stock device flow (a signed-in
  person types the code into a page): obelisk
  approves through Claude, not a page, and keeps
  the device half in a cookie.
- Client ID Metadata Documents (CIMD): the
  server must fetch outside URLs. Obelisk
  uses DCR today. CIMD waits for an asker.

## Not decided here

- Postgres: `auth` keeps Drizzle; its MCP and
  code sign-in wait for the Reylo move.
  `mcp` already fits it.
- Pages: the login, consent and code pages
  are app code (Hedl). The live proof drives
  the flow over HTTP.
- Obelisk's agent-box service key and IP
  allowlist: Hedl app code.
