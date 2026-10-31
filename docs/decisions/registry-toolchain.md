# A registry item declares its toolchain

Date: 2026-10-31. Status: accepted.
Asked by: Hedl on Tinker, gap G0b.
Duke, 2026-10-26: "SQLite is just fine".
ADR `sqlite-variants.md` left this open:
"A toolchain registry item."

## Context

The SQLite items (`database-sqlite`,
`auth-sqlite`, `sync-sqlite`, `blobs-sqlite`)
need the
Reylo toolchain. The `app` item has none of it:

- TypeScript `7.1.0-beta`, in
  `devDependencies` and `overrides`.
- `reylo()` from `reylo/vite`
  in the Vite plugins.
- `contentMappers` in `tsconfig.json`.
- A `typecheck` script that builds the
  dev database and runs `--runExternalCode`.
- `.reylo.yaml`, which names the dev database.
- `maintain/sqlite-dev-db.mjs`, which builds
  the dev database from `sqlite/migrations/`.

So `tinker add` refused them
(`meta.starterOnly`).

Start's rule: nothing generates wiring.
`tinker add` prints the `cmds/*.ts` lines
and writes none of them.

## Precedent

A shadcn registry item has fields for
what it needs beyond its files:

- `dependencies`, `devDependencies`:
  packages. Start already merges these.
- `tailwind`, `cssVars`: config the item
  needs, keyed by where it goes.
- `envVars`: an object of name -> value.
- `docs`: text shown after install.
- `meta`: free data for the registry's own tools.

shadcn writes `tailwind`, `cssVars` and
`envVars` into the app. Start does not write
config, so it only takes their shape:
an object keyed by where the lines go.

## Decision

One field, `meta.toolchain`:
an object of app file -> lines to paste.
`tinker add` prints it; it writes none
of those files.

Filled in for `database-sqlite`:

```json
"toolchain": {
  "package.json": [
    "\"scripts\": { \"typecheck\": \"node maintain/sqlite-dev-db.mjs && DATABASE_URL=file:.tinker/sqlite-dev.db tsc --noEmit --runExternalCode\" }",
    "\"devDependencies\": { \"typescript\": \"7.1.0-beta\" }",
    "\"overrides\": { \"typescript\": \"7.1.0-beta\" }"
  ],
  "tsconfig.json": [
    "\"contentMappers\": [{ \"package\": \"reylo\", \"extensions\": [\".sql\", \".reylo.yaml\", \".reylo.yml\"] }]"
  ],
  "vite.config.ts": [
    "import reylo from \"reylo/vite\";",
    "plugins: [reylo(), ...]",
    "test: { globalSetup: [\"./maintain/sqlite-dev-db.mjs\"] }"
  ],
  ".reylo.yaml": ["direct_url: file:./.tinker/sqlite-dev.db"]
}
```

`tinker add database-sqlite` prints:

```text
Paste into your toolchain (tinker add writes no config):
package.json:
  "scripts": { "typecheck": "node maintain/sqlite-dev-db.mjs && DATABASE_URL=file:.tinker/sqlite-dev.db tsc --noEmit --runExternalCode" }
  "devDependencies": { "typescript": "7.1.0-beta" }
  "overrides": { "typescript": "7.1.0-beta" }
tsconfig.json:
  "contentMappers": [{ "package": "reylo", "extensions": [".sql", ".reylo.yaml", ".reylo.yml"] }]
vite.config.ts:
  import reylo from "reylo/vite";
  plugins: [reylo(), ...]
  test: { globalSetup: ["./maintain/sqlite-dev-db.mjs"] }
.reylo.yaml:
  direct_url: file:./.tinker/sqlite-dev.db
```

- Only `database-sqlite` has the field.
  `auth-sqlite`, `sync-sqlite` and
  `blobs-sqlite` require it, so their
  closure prints it once. `blobs-sqlite`
  needs nothing more: its `.sql` queries use
  the same mapper and dev database.
- `auth-sqlite` adds one line of its own:
  `"overrides": { "@better-auth/core": "1.7.7" }`,
  the pin the starter keeps. Without it npm
  takes a newer core, whose `@better-fetch/fetch`
  breaks `@better-auth/oauth-provider` 1.7.7's
  exact peer (ERESOLVE). Each item prints
  only the lines not printed yet.
- The block comes after the `cmds/*.ts` lines.
  Files keep the order the closure first
  names them; a line prints once.
- It prints for the components that land.
  A kept `database-sqlite` prints nothing.
- `tinker update` prints nothing.
  A release that changes the toolchain
  says so in UPGRADE.md.
- `packages/start/lib/registry.mjs` checks
  the shape. Add, update and check refuse
  a bad one: `bad meta.toolchain in <name>: ...`.
- `meta` is shadcn's free field, so the
  registry format does not change.
- An app with its own `vitest.config.ts`
  pastes the `vite.config.ts` lines there too.

Files the item owns ship as registry files:
the migrations in `sqlite/migrations/` and
`maintain/sqlite-dev-db.mjs`. A component may
now write `drizzle/`, `sqlite/migrations/` and
the one file `maintain/sqlite-dev-db.mjs`.
The rest of `maintain/` is the app's own
scripts, and `tinker prepare` runs that file,
so the fence names the file, not the folder.
On add, a file there with other bytes is a
`conflict:`. On update, an outside file that
the lock does not list (an older lock) and
that has other bytes is a `conflict:` too.
Update refuses it unless `--force`.

The migrations go to `sqlite/migrations/`,
where the demo, Hedl and UPGRADE 0.13.0
already keep them. Before, the registry
said `migrations/`, but no app could get
that copy: `tinker add` refused the items.
The `databaseMigrationsFolder` default is
now `sqlite/migrations` to match, so an
added set migrates with no folder binding.
The starter block ships the same
`maintain/sqlite-dev-db.mjs`. The registry
lets two items share a `maintain/` target
only as one source file.

`meta.starterOnly` is gone. No item used it
after the SQLite items.

### tsgolint and `.sql` imports

The lint (`vp check`, type-aware) runs tsgolint
on TypeScript 7.0. It has no content mappers.
`vp lint --type-aware --type-check` on the
SQLite components gave `TS2307: Cannot find
module './queries/last_id.sql'` for each import.

`database-sqlite/sql.d.ts` declares
`declare module "*.sql"` as a Reylo
`Query<any, any, Cardinality, "sqlite">`.
TypeScript uses a wildcard module only when
the file does not resolve. So:

- tsgolint reads each query as a Reylo query.
  The same lint exits 0.
- `tsc --runExternalCode` (7.1) still resolves
  the file through Reylo first. A probe that
  put `last_id.sql`'s row in a `string`
  failed: `Type '{ id: number; }' is not
assignable to type 'string'`.

The fallback is for tsgolint only. Its risk:
without the pasted `contentMappers` line,
tsc 7.1 would use the fallback too, and a
wrong query type would pass on `any`.
`maintain/sqlite-dev-db.mjs` closes that gap.
The type check and the tests run it first.
When `database-sqlite` is installed and
`tsconfig.json` has no Reylo `contentMappers`,
it stops with an error. The proof has a red
control for each: a wrongly typed query line
fails the type check, and so does a
`tsconfig.json` without the mapper.

## Not decided here

- shadcn's `docs` field. `npx shadcn add`
  prints `docs`, not `meta.toolchain`.
  Copying the lines into `docs` too would
  show them there; not done.
- A toolchain change on `tinker update`.
- A command that prints the toolchain block
  again. Lost `tinker add` output means
  reading `meta.toolchain` in the registry
  JSON. A known gap.
- An offline proof. The proof needs the
  network (shadcn, npm install). A
  composition in `maintain/check-registry.mjs`
  could run offline on the scaffold's
  `node_modules`. Not built.
