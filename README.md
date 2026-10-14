# tinker-app `next`

This branch holds Tinkered Start and its apps. It is a small pnpm workspace.

| Folder                | What it is                                                             |
| --------------------- | ---------------------------------------------------------------------- |
| `packages/start`      | `@tinker/start`: entries, routes, `tinker()`, and the `tinker` command |
| `apps/start-scaffold` | The full app template, its shadcn registry, and `maintain/` checks     |
| `apps/start-min`      | The smallest app on Start                                              |

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

## Not here

These stay in tinkered. Scripts that use them do not run here:

- `docs/roadmap/start-base/proof/`: `packages/start/scripts/proof.sh` and both `scaffold-proof.mjs` write there.
- `packages/core`, `packages/react`: `maintain/proof-registry.mjs`, `proof-no-overwrite.mjs`, and `run-compose-proof.mjs` pack them from source.
- `scripts/prose-lint.mjs`, `scripts/worktree-setup.sh`, `bench/`, `.agents/` at the root, and CI workflows.
