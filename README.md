# tinker-app `next`

This branch holds Tinkered Start and its apps. It is a small pnpm workspace.

| Folder                | What it is                                                         |
| --------------------- | ------------------------------------------------------------------ |
| `packages/start`      | `@tinker/start`: build glue, doctor, and the host command          |
| `apps/start-scaffold` | The full app template, its shadcn registry, and `maintain/` checks |
| `apps/start-min`      | The smallest app on Start                                          |

The history of these folders came from `lagz0ne/tinkered` (`main` at `fef10e46`).
The paths are the same as in tinkered, so tinkered commits on them apply here as they are.

`@tinker/core` and `@tinker/react` are not in this workspace. They come from the
tinkered GitHub release `start-v0.9.0` as tarball URLs:

```json
"@tinker/core": "https://github.com/lagz0ne/tinkered/releases/download/start-v0.9.0/tinker-core-0.9.0.tgz",
"@tinker/react": "https://github.com/lagz0ne/tinkered/releases/download/start-v0.9.0/tinker-react-0.9.0.tgz"
```

To move to a newer core or react, change both URLs in each `package.json` and run `pnpm install`.

## Run

```bash
pnpm install
pnpm --filter @tinker/start test
pnpm --filter @tinker-start-scaffold build
pnpm --filter @tinker-start-scaffold doctor
vp check
```

## Release

A tag `start-vX.Y.Z` on `next` holds one asset: the Start tarball.
Core and React keep their tinkered `start-v0.9.0` tarball URLs.
The registry is read from the tag's own `apps/start-scaffold/public/r`.

Start 0.10.0 is released from tag `start-v0.10.0`. It ships the current main contract.
Default exports and registry installs use that host and registry.

For each release, set the package version and add its released UPGRADE.md
section. Keep that version, the release assets, and the registry in step. Then:

```bash
node packages/start/scripts/copy-contract.mjs
pnpm --dir apps/start-scaffold run registry:build
node scripts/release.mjs 0.10.0
node scripts/release-check.mjs 0.10.0 > .release/start-v0.10.0/notes.md
```

`release.mjs` packs Start into `.release/start-v0.10.0/`.
`copy-contract.mjs` writes the contract that Start ships, `packages/start/docs/contract.md`.
Its links name this version's tag, so run it after you set the version.
`release-check.mjs` checks the version, the UPGRADE.md section, and the registry links.
It also fails when `packages/start/docs/contract.md` is not the copy for this version.
Neither script publishes.

## Copied runtime and templates

Start runtime source lives in `apps/start-scaffold/tinker/`.
Each component has one registry item with its direct dependencies.
The small app carries the same base and shared component files.
Commands bind app values by hand. Components never import commands or base.

`src/` is user code. The `app` registry item owns its shell and styles.
Demo examples ship their shell/style shape under `examples/` for manual edits.
The registry keeps one owner per target. Component updates replace files whole.

```bash
node apps/start-scaffold/maintain/template-sync.mjs /tmp/tinker-app-export
```

It exports small and demo copies into an empty output folder.
It refuses a source tooling version below 0.10.0.
It never changes another checkout, branch, or tag.

To check an export now with an explicit pack of the current host:

```bash
node apps/start-scaffold/maintain/proof-export.mjs
```

This proof installs and checks a temporary export without a global package manager.

Run heavy jobs one at a time with `VITEST_MAX_WORKERS=1` and
`VP_RUN_CONCURRENCY_LIMIT=1`. The native scaffold and entry proofs run here.
The real registry proof packs local Start and uses the existing Core/React release URLs.
Its HTTP server stays on loopback. Nothing is published.

The original prose lint and CI workflows are not in this checkout.
The lander runs mutations: 85 for the golden copied runtime, 75 for tooling.
