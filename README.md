# Tinker app on TanStack Router and Bun

No TanStack Start. Two builds, one per side.

- Browser: TanStack Router SPA, Tinker Core and React.
- Server: `Bun.serve`, Tinker Core 0.10.0 capsules.
- One root per command.

Start a new app from it:

```bash
npx degit lagz0ne/tinker-app/variants/router-bun my-app
cd my-app && bun install
```

## Run

```bash
bun run dev      # Bun bundles the page on request
bun run check    # tsc, tests, both builds, client check
bun run start    # the built server
```

`dev` and `start` need the telemetry env:

- `OTEL_SERVICE_NAME`
- `VICTORIA_TRACES_URL`
- `VICTORIA_LOGS_URL`

A missing one exits 78 and names the key.

## Two builds

- `build:client`: `cmds/index.html`, browser target,
  to `dist/client`, with a metafile.
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
- `cmds/server.ts`: `rpc.server({ api, provide })`.
  `provide` is `satisfies Providers<typeof api>`,
  so a missing provider is a type error.
- `cmds/browser.tsx`: `rpc.client({ api })`.
- Start fails with `MissingConfig` when a
  contract has no provider.
- A failure the provider raises reaches the tab
  with the same kind and payload.

## Where things are

- `cmds/server.ts`: the root, rpc, the route table.
- `cmds/browser.tsx`: the tab root and the router.
- `cmds/dev.ts`, `cmds/host.ts`: `Bun.serve` for
  dev and for the build.
- `tinker/components/rpc`: `rpc.server`, `rpc.client`.
- `tinker/components/requests`: the `routes`
  capsule. A route is any operation.
- `tinker/components/telemetry`: the sink capsules.

## Known limits

- Bun HMR breaks TanStack Router (a null module
  in `router-core`), so HMR is off. Reload the tab
  after an edit.
- No server render.
- The tab does not check a reply's shape.
- A trace crosses from tab to server by a W3C
  `traceparent` header; no header starts a fresh trace.
