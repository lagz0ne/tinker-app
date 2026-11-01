# tinker-app

A Tinker app on TanStack Router and `Bun.serve`.
Two builds, one per side.

## Start an app

```bash
npx degit lagz0ne/tinker-app my-app
cd my-app && bun install
```

Pin a release with `#vX.Y.Z`:

```bash
npx degit lagz0ne/tinker-app#v0.18.0 my-app
```

## Run

```bash
bun run dev      # dev server, Bun bundles on request
bun run check    # tsc, tests, both builds, check:client
bun run build    # both builds, then the client check
bun run start    # the built server
```

`dev` and `start` need three telemetry keys:

- `OTEL_SERVICE_NAME`
- `VICTORIA_TRACES_URL`
- `VICTORIA_LOGS_URL`

A missing one exits 78.
`.env.example` lists the safe defaults.

## Checks

`bun run check` runs tsc, `bun test`, both
builds, then `check:client`.

`bun run check:style` is `vp check`: oxfmt
and oxlint, with rules in `vite.config.ts`.

`bun run check:plain` bans plain helper
functions. Every function is an operation or
a capsule hook. `cn` and `defineMain` are
exempt.

`.github/workflows/gates.yml` runs all three
on each push to `main`, and weekly.

## Two builds

- `build:client`: `cmds/index.html`, browser
  target, to `dist/client`, with a metafile.
- `build:server`: `cmds/host.ts` and the
  telemetry worker, Bun target, to `dist/server`.
- `check:client`: reads the client metafile.
  It fails if a server module is in the client
  build: a `*.server.ts` file, `src/backend`,
  a server cmd, or a `node:` or `bun:` import.

## rpc: one op, two places

The tab and the server run the same op handle.

- `src/api/`: the contracts, plain ops with no
  body. `api` lists them, keyed by label.
- `src/backend/`: the providers. Each ends with
  `satisfies typeof <contract>`.
- `cmds/server.ts`: `rpc.server` with
  `{ api, provide }`.
  `provide` is `satisfies Providers<typeof api>`,
  so a missing provider is a type error.
- `cmds/browser.tsx`: `rpc.client({ api })`.
- The root fails to start with `MissingConfig`
  when a contract has no provider.
- A failure the provider raises reaches the tab
  with the same kind and payload.

The tab sends a W3C `traceparent` header, so
the server span is the tab span's child.

## Where things are

- `cmds/server.ts`: the root, rpc, the table.
- `cmds/browser.tsx`: the tab root and the router.
- `cmds/dev.ts`, `cmds/host.ts`: `Bun.serve` for
  dev and for the build.
- `tinker/components/rpc`: `rpc.server`,
  `rpc.client`.
- `tinker/components/requests`: the `routes`
  capsule. A route is any operation.
- `tinker/components/telemetry`: the sink
  capsules.
- `scripts/`: `check-client`, `check-plain`.
- `tests/`: `bun test` files for rpc, routes,
  trace, health and `check-plain`.

Components in `tinker/components/` are plain
folders. Edit them in place. There is no
`tinker` CLI, registry or `components.lock`
any more.

## Known limits

- Bun HMR breaks TanStack Router (a null module
  in `router-core`), so HMR is off. Reload the tab
  after an edit.
- No server render.
- The tab does not check a reply's shape.

## Releases

After green gates on `main`, CI tags `v<version>`
from `package.json`, when that tag is missing.
Bump `version` to release.

## Where Start went

Start, the loop, the Start apps and the `tinker`
CLI were removed on 2026-11-01.
They live in the tag `start-archive`.
Old degit links keep working: branches `small`
and `demo`, tags `small-v*`, `demo-v*`,
`start-v*`.

```bash
git checkout start-archive
npx degit lagz0ne/tinker-app#start-archive old-start
```
