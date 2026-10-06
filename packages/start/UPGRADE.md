# Upgrade notes for `@tinker/start`

`tinker upgrade` prints the sections between your old and new version.

## 0.2.0

The base reads five named files, and no others:
`src/router.ts`, `src/start.ts`, `src/server.ts`,
`src/routes/__root.tsx`, and `src/style.css`.

- Move router options from `src/router.tsx`
  to `export const router` in `src/router.ts`.
- `vp build` now stops on a type error,
  and on each mistake `tinker doctor` names.
- Add `"postinstall": "tinker prepare"`
  to `package.json`, or run `tinker doctor --fix`.
- Add `.tanstack/` to `.gitignore`.

## 0.1.1

`/api/health` replies with `Cache-Control: no-store`.
No app change is needed.

## 0.1.0

The first base: Start bridge, entries, `/api/health`, `/tinker`.
