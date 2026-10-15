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
tinkered GitHub release `start-v0.8.0` as tarball URLs:

```json
"@tinker/core": "https://github.com/lagz0ne/tinkered/releases/download/start-v0.8.0/tinker-core-0.8.0.tgz",
"@tinker/react": "https://github.com/lagz0ne/tinkered/releases/download/start-v0.8.0/tinker-react-0.8.0.tgz"
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

This exports small and demo copies from source into an empty output folder.
It never changes another checkout, branch, or tag.

Run heavy jobs one at a time with `VITEST_MAX_WORKERS=1` and
`VP_RUN_CONCURRENCY_LIMIT=1`. The native scaffold and entry proofs run here.
The real registry proof packs local Start and uses the existing Core/React release URLs.
Its HTTP server stays on loopback. Nothing is published.

The original prose lint and CI workflows are not in this checkout.
The lander runs mutations: 85 for the golden copied runtime, 75 for tooling.
