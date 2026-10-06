#!/usr/bin/env bash
# The hardened base's proof (ADR 0106), from the repo root, after vp install && vp run -r build.
# 8: apps/start-min on the workspace link: build, serve, curl, doctor.
# 9: each known silent mistake, in a scratch copy of apps/start-min on the packed base:
#    vp build stops with doctor's file:line message, or doctor names it.
# 10: what the base now does: named files, style, public/, .env, prod errors.
# 11: a fresh clone: tinker prepare (the postinstall) writes the route tree; tsc passes.
# 12: the telemetry part: on, records reach a stand-in storage; off, /api/telemetry is the app's.
# 13: the auth part: on, a stand-in seam's handler answers /api/auth/*; off, the path is the app's;
#     a seam without a name the part reads stops the build; a bad key is named in .env.
# 14: the sync part (3a, the server side): on, /api/sync streams a stand-in in-memory database's
#     events; off, the path is the app's; a seam without database stops the build; auth: false fails.
# 15: the sync part's client (3b): getBootstrap answers the server render; the hydrated tab opens
#     /api/sync and shows a commit made after it loaded; a client seam without a name stops the build.
# Logs land in docs/roadmap/start-base/proof/. Builds, servers, and curl are proofs here, never unit tests.
set -uo pipefail
repo=$(pwd)
out=$repo/docs/roadmap/start-base/proof
scratch=/tmp/tinker-proof
clean() { sed -e "s|$scratch/app/||g" -e "s|$scratch|\$S|g" -e "s|$repo/||g" -e "s|$HOME|~|g"; }
say() { echo "\$ $*"; }

build() {
  say "vp build"
  rm -rf dist
  vp build > /tmp/tinker-proof-build.log 2>&1
  local code=$?
  grep -aE "tinker doctor|tsc found|TS[0-9]{4}|tinker\(\)|tinker: " /tmp/tinker-proof-build.log | head -${1:-6}
  echo "vp build: EXIT $code"
}
doctor() {
  say "tinker doctor $*"
  node node_modules/@tinker/start/bin/tinker.mjs doctor "$@" > /tmp/tinker-proof-doctor.log 2>&1
  local code=$?
  awk '/^(fail|fixed)/{p=1} /^(ok|skip)/{p=0} p' /tmp/tinker-proof-doctor.log
  tail -1 /tmp/tinker-proof-doctor.log
  echo "EXIT $code"
}
serve_up() {
  port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  PORT=$port node node_modules/@tinker/start/bin/tinker.mjs serve > /tmp/tinker-proof-serve.log 2>&1 &
  server=$!
  for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$port/api/health" && break; sleep 0.2; done
}
serve_down() {
  kill -INT "$server"
  wait "$server"
  echo "server stopped: EXIT $?"
}
get() {
  say "curl -s :PORT$1 | grep -ao '$2'"
  curl -s "http://127.0.0.1:$port$1" | grep -ao "$2" | head -3
}

# A scratch copy of apps/start-min with the packed base installed as a real folder.
fresh() {
  rm -rf "$scratch/app"
  mkdir -p "$scratch/app/node_modules/@tinker" "$scratch/app/node_modules/.bin"
  (cd apps/start-min && tar -c --exclude=node_modules --exclude=dist --exclude=.tinker --exclude=.tanstack .) |
    tar -C "$scratch/app" -x
  for entry in apps/start-min/node_modules/* apps/start-min/node_modules/@*/*; do
    name=${entry#apps/start-min/node_modules/}
    [[ $name == @* && $name != */* ]] && continue
    [[ $name == @tinker/start ]] && continue
    mkdir -p "$(dirname "$scratch/app/node_modules/$name")"
    ln -sfn "$(readlink -f "$entry")" "$scratch/app/node_modules/$name"
  done
  cp -r "$scratch/base/package" "$scratch/app/node_modules/@tinker/start"
  ln -sfn "$repo/packages/start/node_modules" "$scratch/app/node_modules/@tinker/start/node_modules"
  for bin in vp tsc; do ln -sfn "$(readlink -f "apps/start-min/node_modules/.bin/$bin")" "$scratch/app/node_modules/.bin/$bin"; done
  (cd "$scratch/app" && node node_modules/@tinker/start/bin/tinker.mjs prepare > /dev/null 2>&1)
}
mistake() {
  echo
  echo "## $1"
  cd "$repo" && fresh && cd "$scratch/app"
}

rm -rf "$scratch" && mkdir -p "$scratch/base"
(cd packages/start && rm -rf packs && node scripts/pack.mjs > /dev/null)
tar -xzf packages/start/packs/tinker-start-*.tgz -C "$scratch/base"

{
  cd "$repo/apps/start-min"
  echo "base folder: $(readlink -f node_modules/@tinker/start)"
  build
  "$repo/packages/start/scripts/curl-app.sh" .
  cd "$repo/apps/start-min"
  doctor
} 2>&1 | clean > "$out/8-hardened-app-min.txt"

{
  mistake "control: the packed base, nothing broken"
  build
  doctor

  mistake "Start's usual src/router.tsx, which the glue never reads"
  printf 'export const getRouter = () => ({ defaultPreload: "intent" });\n' > src/router.tsx
  build
  doctor

  mistake "a route exports route, not Route"
  sed -i 's/export const Route = createFileRoute/export const route = createFileRoute/; s/Route.useLoaderData/route.useLoaderData/' src/routes/index.tsx
  build
  doctor

  mistake "a user __root.tsx without <Outlet />"
  printf '%s\n' 'import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";' \
    'export const Route = createRootRoute({' \
    '  component: () => <main>the shell, no outlet</main>,' \
    '  shellComponent: ({ children }) => (<html lang="en"><head><HeadContent /></head><body>{children}<Scripts /></body></html>),' \
    '});' > src/routes/__root.tsx
  build
  doctor

  mistake "base files imported by path and by a base-only name"
  printf '%s\n' 'import { raise } from "../../node_modules/@tinker/start/src/errors.ts";' \
    'import { extensions } from "#tinker/app.server";' \
    'export const peek = [raise, extensions];' > src/backend/peek.ts
  build
  doctor

  mistake "routes that take or nest under the base's /tinker"
  mkdir -p src/routes/tinker
  printf 'import { createFileRoute } from "@tanstack/react-router";\nexport const Route = createFileRoute("/tinker/")({ component: () => <p>mine</p> });\n' > src/routes/tinker/index.tsx
  printf 'import { createFileRoute } from "@tanstack/react-router";\nexport const Route = createFileRoute("/tinker/settings")({ component: () => <p>mine</p> });\n' > src/routes/tinker/settings.tsx
  build
  doctor

  mistake "a stylesheet nothing links"
  printf 'p { color: red; }\n' > src/styles.css
  build
  doctor

  mistake "a user shell that does not link src/style.css"
  printf 'p { color: red; }\n' > src/style.css
  printf '%s\n' 'import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";' \
    'export const Route = createRootRoute({' \
    '  component: () => <Outlet />,' \
    '  shellComponent: ({ children }) => (<html lang="en"><head><HeadContent /></head><body>{children}<Scripts /></body></html>),' \
    '});' > src/routes/__root.tsx
  build
  doctor

  mistake "a <Link to> typo"
  printf 'import { createFileRoute, Link } from "@tanstack/react-router";\nexport const Route = createFileRoute("/nav")({ component: () => <Link to="/tinkr">base</Link> });\n' > src/routes/nav.tsx
  build
  doctor

  mistake "shadcn aliases under a stale .tinker/ with a relative @/*"
  printf '{ "tailwind": { "css": "src/style.css" }, "aliases": { "ui": "@/components/ui" } }\n' > components.json
  printf '@import "tailwindcss";\n' > src/style.css
  sed -i 's|"/[^"]*/src/\*"|"../src/*"|' .tinker/tsconfig.json
  doctor
  doctor --fix

  mistake "a new route while no dev server runs: the route tree is stale"
  printf 'import { createFileRoute } from "@tanstack/react-router";\nexport const Route = createFileRoute("/later")({ component: () => <p>later</p> });\n' > src/routes/later.tsx
  doctor
  doctor --fix
  say "grep -c later .tinker/routeTree.gen.ts"
  grep -c later .tinker/routeTree.gen.ts

  mistake "a route clash while no dev server runs: tinker prepare says so"
  printf 'import { createFileRoute } from "@tanstack/react-router";\nexport const Route = createFileRoute("/tinker")({ component: () => <p>mine</p> });\n' > src/routes/tinker.tsx
  say "tinker prepare"
  node node_modules/@tinker/start/bin/tinker.mjs prepare 2>&1 | grep -a "tinker prepare\|^\.tinker\|^src/"
  echo "EXIT ${PIPESTATUS[0]}"
  doctor

  mistake "two tinker() calls in vite.config.ts"
  sed -i 's/plugins: \[tinker()\]/plugins: [tinker(), tinker()]/' vite.config.ts
  build
  doctor

  mistake "a named file without the export the base reads"
  printf 'export const start = 1;\n' > src/start.ts
  build
  doctor

  mistake "a tinker() option the base would drop"
  sed -i 's/tinker()/tinker({ prerendr: { enabled: true } })/' vite.config.ts
  build 2
} 2>&1 | clean > "$out/9-build-stops.txt"

{
  mistake "named files: src/router.ts, src/start.ts, src/server.ts, src/style.css"
  mkdir -p src/frontend
  printf 'export const NotFound = () => <p>app 404 page</p>;\n' > src/frontend/not-found.tsx
  printf '%s\n' 'import type { RouterOptions } from "@tinker/start";' \
    'import { NotFound } from "./frontend/not-found.tsx";' \
    'export const router: RouterOptions = () => ({ defaultNotFoundComponent: NotFound });' > src/router.ts
  printf '%s\n' 'import { createMiddleware, createStart } from "@tanstack/react-start";' \
    'import { setResponseHeader } from "@tanstack/react-start/server";' \
    'const stamp = createMiddleware().server(({ next }) => {' \
    '  setResponseHeader("x-app-middleware", "yes");' \
    '  return next();' \
    '});' \
    'export const startInstance = createStart(() => ({ requestMiddleware: [stamp] }));' > src/start.ts
  printf '%s\n' 'import { createServerEntry } from "@tinker/start/server";' \
    'export default createServerEntry({' \
    '  async fetch(request, next) {' \
    '    if (new URL(request.url).pathname === "/raw") return new Response("raw from src/server.ts");' \
    '    return next(request);' \
    '  },' \
    '});' > src/server.ts
  printf 'p { color: rgb(1, 2, 3); }\n' > src/style.css
  mkdir -p public && printf 'User-agent: *\n' > public/robots.txt
  printf 'GREETING=from-dot-env\n' > .env
  printf '%s\n' 'import { createFileRoute } from "@tanstack/react-router";' \
    'export const Route = createFileRoute("/api/env")({' \
    '  server: { handlers: { GET: () => Response.json({ greeting: process.env.GREETING ?? "unset" }) } },' \
    '});' > src/routes/api.env.ts
  printf '%s\n' 'import { createFileRoute } from "@tanstack/react-router";' \
    'import { createServerFn } from "@tanstack/react-start";' \
    'const boom = createServerFn({ method: "GET" }).handler(() => {' \
    '  throw new Error("boom: secret detail");' \
    '});' \
    'export const Route = createFileRoute("/boom")({ loader: () => boom(), component: () => <p>never</p> });' > src/routes/boom.tsx
  build
  doctor
  serve_up
  get / '<link rel="stylesheet"[^>]*>'
  get /nope '<p>app 404 page</p>'
  get /raw 'raw from src/server.ts'
  say "curl -sI :PORT/ | grep x-app-middleware"
  curl -sI "http://127.0.0.1:$port/" | grep -i x-app-middleware | tr -d '\r'
  say "curl -si :PORT/robots.txt | head -1"
  curl -si "http://127.0.0.1:$port/robots.txt" | head -1 | tr -d '\r'
  get /api/env '"greeting":"[^"]*"'
  say "curl -s :PORT/boom: the page, then the error text"
  curl -s "http://127.0.0.1:$port/boom" > /tmp/tinker-proof-boom.html
  grep -ao '<h1>Something went wrong</h1>' /tmp/tinker-proof-boom.html
  echo "visible <pre> with the error: $(grep -ac '<pre>boom' /tmp/tinker-proof-boom.html)"
  echo "error text in the page data (TanStack, P4): $(grep -ac 'boom: secret detail' /tmp/tinker-proof-boom.html)"
  serve_down
  say "grep 'tinker: a route failed' server log"
  grep -a "tinker: a route failed" /tmp/tinker-proof-serve.log | cut -c1-90
} 2>&1 | clean > "$out/10-base-does.txt"

{
  mistake "a fresh clone: no .tinker/ at all"
  rm -rf .tinker
  say "tsc --noEmit (before prepare)"
  node_modules/.bin/tsc --noEmit 2>&1 | head -2
  say "tinker prepare  (the postinstall)"
  node node_modules/@tinker/start/bin/tinker.mjs prepare 2>&1 | grep tinker
  say "tsc --noEmit"
  node_modules/.bin/tsc --noEmit
  echo "tsc: EXIT $?"
  doctor
} 2>&1 | clean > "$out/11-fresh-clone.txt"

# A stand-in for VictoriaTraces and VictoriaLogs: it keeps each POST's path and body.
cat > "$scratch/receiver.mjs" <<'JS'
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
const [port, out] = process.argv.slice(2);
createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  appendFileSync(out, `${request.method} ${request.url}\n${body}\n`);
  response.writeHead(204).end();
}).listen(Number(port), "127.0.0.1");
JS
post() {
  say "curl -X POST :PORT/api/telemetry, origin $1: ${2:0:60}"
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://127.0.0.1:$port/api/telemetry" \
    -H "origin: $1" -H "content-type: application/json" --data "$2"
}
tab='{"traces":[],"logs":[{"time":1,"level":30,"msg":"from a tab","side":"browser","service":"tab"}]}'

{
  mistake "telemetry on (the default): a page and a tab's batch reach storage"
  rport=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  node "$scratch/receiver.mjs" "$rport" "$scratch/received.txt" &
  receiver=$!
  printf 'VICTORIA_TRACES_URL=http://127.0.0.1:%s/traces\nVICTORIA_LOGS_URL=http://127.0.0.1:%s/logs\nOTEL_SERVICE_NAME=start-min\n' "$rport" "$rport" > .env
  build
  say "cat .tinker/parts.server.ts"
  cat .tinker/parts.server.ts
  doctor
  serve_up
  get / '<p>[^<]*</p>'
  post "http://127.0.0.1:$port" "$tab"
  post "http://other.test" "$tab"
  serve_down
  kill "$receiver"
  say "what storage got"
  grep -ao '^POST /[a-z]*' "$scratch/received.txt" | sort | uniq -c
  echo "spans: $(grep -ao '"name":"[a-z.]*","kind"' "$scratch/received.txt" | cut -d'"' -f4 | sort -u | tr '\n' ' ')"
  grep -ao '{"time":1,[^}]*}' "$scratch/received.txt"
  say "grep -c core.span server log"
  grep -ac '"msg":"core.span"' /tmp/tinker-proof-serve.log

  mistake "telemetry off: /api/telemetry is the app's own route"
  sed -i 's/tinker()/tinker({ telemetry: false })/' vite.config.ts
  printf '%s\n' 'import { createFileRoute } from "@tanstack/react-router";' \
    'export const Route = createFileRoute("/api/telemetry")({' \
    '  server: { handlers: { POST: () => new Response("the app takes it", { status: 200 }) } },' \
    '});' > src/routes/api.telemetry.ts
  printf 'VICTORIA_TRACES_URL=not a url\n' > .env
  build
  say "cat .tinker/parts.server.ts"
  cat .tinker/parts.server.ts
  doctor
  serve_up
  post "http://127.0.0.1:$port" "$tab"
  say "curl -s -X POST :PORT/api/telemetry"
  curl -s -X POST "http://127.0.0.1:$port/api/telemetry"; echo
  say "grep -c core.span server log"
  grep -ac '"msg":"core.span"' /tmp/tinker-proof-serve.log
  serve_down

  mistake "telemetry on, and the app's own /api/telemetry: the build names the switch"
  printf '%s\n' 'import { createFileRoute } from "@tanstack/react-router";' \
    'export const Route = createFileRoute("/api/telemetry")({' \
    '  server: { handlers: { POST: () => new Response("the app takes it") } },' \
    '});' > src/routes/api.telemetry.ts
  build
  doctor

  mistake "telemetry on, and a bad storage URL in .env: doctor names its line"
  printf '# storage\nVICTORIA_TRACES_URL=not a url\n' > .env
  doctor
} 2>&1 | clean > "$out/12-telemetry-part.txt"

# The auth part's stand-in server seam: an auth library that answers with what it was sent.
seam() {
  mkdir -p src/lib
  printf '%s\n' 'import { operation, resource } from "@tinker/core";' \
    'import { authSettings } from "@tinker/start/server";' \
    'export const extensions = [];' \
    'export const auth = resource({' \
    '  label: "auth",' \
    '  depends: { settings: authSettings },' \
    '  factory: ({ settings }) => ({' \
    '    handler: async (request: Request) =>' \
    '      Response.json({ handled: `${request.method} ${new URL(request.url).pathname}`, origin: settings.origin }),' \
    '  }),' \
    '});' > src/lib/tinker.server.ts
  [[ ${1:-} == no-readAccount ]] && return
  printf '%s\n' 'export const readAccount = operation({ label: "readAccount", run: () => null });' >> src/lib/tinker.server.ts
}
keys() { printf 'PUBLIC_ORIGIN=http://127.0.0.1:4318\nAUTH_SECRET=%s\n' "$(printf 's%.0s' $(seq 1 32))" > .env; }
appAuthRoute() {
  printf '%s\n' 'import { createFileRoute } from "@tanstack/react-router";' \
    'export const Route = createFileRoute("/api/auth/$")({' \
    '  server: { handlers: { GET: () => new Response("the app takes it") } },' \
    '});' > 'src/routes/api.auth.$.ts'
}

{
  mistake "auth on, with a stand-in seam: the handler answers /api/auth/*"
  sed -i 's/tinker()/tinker({ auth: true })/' vite.config.ts
  seam
  keys
  build
  say "cat .tinker/parts.server.ts"
  cat .tinker/parts.server.ts
  doctor
  serve_up
  get /api/auth/get-session '"handled":"[^"]*","origin":"[^"]*"'
  say "curl -s -X POST :PORT/api/auth/sign-in/email"
  curl -s -X POST -H "origin: http://127.0.0.1:$port" "http://127.0.0.1:$port/api/auth/sign-in/email"; echo
  serve_down

  mistake "auth off (the default): /api/auth/* is the app's own"
  appAuthRoute
  build
  say "cat .tinker/parts.server.ts"
  cat .tinker/parts.server.ts
  doctor
  serve_up
  get /api/auth/get-session 'the app takes it'
  serve_down

  mistake "auth on, and the app's own /api/auth/\$: the build names the switch"
  sed -i 's/tinker()/tinker({ auth: true })/' vite.config.ts
  seam
  keys
  appAuthRoute
  build
  doctor

  mistake "auth on, and a seam without readAccount: the build stops"
  sed -i 's/tinker()/tinker({ auth: true })/' vite.config.ts
  seam no-readAccount
  keys
  build
  doctor

  mistake "auth on, and no seam at all: the build stops"
  sed -i 's/tinker()/tinker({ auth: true })/' vite.config.ts
  keys
  build
  doctor

  mistake "auth on, a short secret and no origin: doctor names them"
  sed -i 's/tinker()/tinker({ auth: true })/' vite.config.ts
  seam
  printf '# auth\nAUTH_SECRET=short\n' > .env
  build
  doctor
} 2>&1 | clean > "$out/13-auth-part.txt"

# The sync part's stand-in server seam: auth with no one signed in, and an in-memory PGlite
# database with the sync tables and two public events. PGlite is linked from the base's dev tools.
syncSeam() {
  ln -sfn "$(readlink -f "$repo/packages/start/node_modules/@electric-sql/pglite")" node_modules/@electric-sql/pglite 2>/dev/null ||
    { mkdir -p node_modules/@electric-sql && ln -sfn "$(readlink -f "$repo/packages/start/node_modules/@electric-sql/pglite")" node_modules/@electric-sql/pglite; }
  ln -sfn "$(readlink -f "$repo/packages/start/node_modules/drizzle-orm")" node_modules/drizzle-orm
  mkdir -p src/lib
  cat > src/lib/tinker.server.ts <<'TS'
import { operation, resource } from "@tinker/core";
import { authSettings } from "@tinker/start/server";
import type { Database } from "@tinker/start/server";

export const extensions = [];
export const auth = resource({
  label: "auth",
  depends: { settings: authSettings },
  factory: ({ settings }) => ({
    handler: async (request: Request) =>
      Response.json({ handled: new URL(request.url).pathname, origin: settings.origin }),
    api: {
      getSession: async (_options: { headers: Headers; query?: object }): Promise<{ user: { id: string } } | null> =>
        null,
    },
  }),
});
export const readAccount = operation({ label: "readAccount", run: () => null });
TS
  [[ ${1:-} == no-database ]] && return
  cat >> src/lib/tinker.server.ts <<'TS'
export const database = resource({
  label: "database",
  factory: async (_deps, { defer }): Promise<Database.Handle> => {
    const [{ PGlite }, { drizzle }] = await Promise.all([
      import("@electric-sql/pglite"),
      import("drizzle-orm/pglite"),
    ]);
    const client = await PGlite.create();
    defer(() => client.close());
    await client.exec(`
      CREATE TABLE sync_stream (id text PRIMARY KEY, revision integer DEFAULT 0 NOT NULL);
      CREATE TABLE sync_execution (id text PRIMARY KEY, stream text NOT NULL, notification jsonb, result jsonb);
      CREATE TABLE sync_event (stream text, revision integer, "executionId" text NOT NULL,
        payload jsonb NOT NULL, PRIMARY KEY (stream, revision));
      INSERT INTO sync_event VALUES
        ('public', 1, '00000000-0000-4000-8000-000000000001', '{"kind":"change","change":{"count":1}}'),
        ('public', 2, '00000000-0000-4000-8000-000000000002', '{"kind":"change","change":{"count":2}}');
    `);
    return Object.assign(drizzle({ client }), {
      listen: async (wake: () => void) => client.listen("start_sync", wake),
    });
  },
});
TS
}
appSyncRoute() {
  printf '%s\n' 'import { createFileRoute } from "@tanstack/react-router";' \
    'export const Route = createFileRoute("/api/sync")({' \
    '  server: { handlers: { GET: () => new Response("the app takes it") } },' \
    '});' > src/routes/api.sync.ts
}

{
  mistake "sync on, with stand-in seams: /api/sync streams the database's events"
  sed -i 's/tinker()/tinker({ sync: true })/' vite.config.ts
  syncSeam
  keys
  build
  say "cat .tinker/parts.server.ts"
  cat .tinker/parts.server.ts
  say "jq .parts .tinker/base.json"
  node -e 'console.log(JSON.stringify(require("./.tinker/base.json").parts))'
  doctor
  serve_up
  say "curl -s -N --max-time 8 :PORT/api/sync  (the first request starts PGlite)"
  curl -s -N --max-time 8 -w 'first byte after %{time_starttransfer} s\n' "http://127.0.0.1:$port/api/sync"
  echo "curl: EXIT $?"
  say "curl -s -N --max-time 2 :PORT/api/sync, Last-Event-ID: {\"public\":1,\"private\":null}"
  curl -s -N --max-time 2 -H 'Last-Event-ID: {"public":1,"private":null}' "http://127.0.0.1:$port/api/sync"
  echo "curl: EXIT $?"
  say "curl -s -o /dev/null -w '%{http_code}' :PORT/api/sync?cursor=bad"
  curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$port/api/sync?cursor=bad"
  serve_down

  mistake "sync off (the default): /api/sync is the app's own"
  appSyncRoute
  build
  doctor
  serve_up
  get /api/sync 'the app takes it'
  serve_down

  mistake "sync on, and the app's own /api/sync: the build names the switch"
  sed -i 's/tinker()/tinker({ sync: true })/' vite.config.ts
  syncSeam
  keys
  appSyncRoute
  build
  doctor

  mistake "sync on, and a seam without database: the build stops"
  sed -i 's/tinker()/tinker({ sync: true })/' vite.config.ts
  syncSeam no-database
  keys
  build
  doctor

  mistake "sync on, with auth: false: the build fails"
  sed -i 's/tinker()/tinker({ sync: true, auth: false })/' vite.config.ts
  syncSeam
  keys
  build 2
} 2>&1 | clean > "$out/14-sync-part.txt"

# The sync app: stand-in seams on both sides, a page that shows the public count from the tab's
# records, and a route that commits the next count as a sync event.
syncApp() {
  sed -i 's/tinker()/tinker({ sync: true })/' vite.config.ts
  syncSeam
  keys
  cat >> src/lib/tinker.server.ts <<'TS'
export const bootstrap = operation({
  label: "bootstrap",
  depends: { database, history: eventHistory },
  run: async ({ database, history }) =>
    database.transaction(async (tx) => {
      const count = await history.lock(tx, "public");
      return { public: { stream: "public" as const, revision: count, count }, private: null };
    }),
});
TS
  sed -i 's|^import { authSettings } from "@tinker/start/server";|import { authSettings, eventHistory } from "@tinker/start/server";|' src/lib/tinker.server.ts
  sed -i 's|        payload jsonb NOT NULL, PRIMARY KEY (stream, revision));|        payload jsonb NOT NULL, PRIMARY KEY (stream, revision));\n      CREATE FUNCTION start_sync_wake() RETURNS trigger LANGUAGE plpgsql AS $$\n      BEGIN PERFORM pg_notify('"'"'start_sync'"'"', TG_TABLE_NAME); RETURN NULL; END; $$;\n      CREATE TRIGGER sync_event_committed AFTER INSERT ON sync_event\n      FOR EACH STATEMENT EXECUTE FUNCTION start_sync_wake();|' src/lib/tinker.server.ts
  sed -i "s|      INSERT INTO sync_event VALUES|      INSERT INTO sync_stream VALUES ('public', 2);\n      INSERT INTO sync_event VALUES|" src/lib/tinker.server.ts
  mkdir -p src/frontend src/backend
  cat > src/frontend/count.ts <<'TS'
import { data } from "@tinker/core";
export const count = data<number>({ label: "count", initial: 0 });
TS
  cat > src/lib/tinker.ts <<'TS'
import { resource } from "@tinker/core";
import {
  batchEnvelope,
  bootstrapEnvelope,
  eventEnvelope,
  snapshotEnvelope,
} from "@tinker/start";
import type { Sync } from "@tinker/start";
import { z } from "zod";
import { count } from "../frontend/count.ts";

declare module "@tinker/start" {
  interface Register {
    change: { count: number };
    result: { kind: "done" };
    public: { count: number };
    private: Record<never, never>;
  }
}
export const extensions = [];
export const records = resource({
  label: "records",
  depends: { value: count.controller },
  factory: ({ value }): Sync.Records => ({
    resetPrivate() {},
    bootstrapPublic(saved: Sync.Public, after: number) {
      if (saved.revision >= after) value.set(saved.count);
    },
    bootstrapPrivate() {},
    change(change: Sync.Change) {
      value.set(change.count);
    },
    snapshot(publicRevision: number): Sync.Snapshot {
      return {
        public: { stream: "public", revision: Math.max(0, publicRevision), count: value.get() },
        private: null,
      };
    },
  }),
});
export const readSnapshot = snapshotEnvelope.extend({
  public: z.object({ stream: z.literal("public"), revision: z.number().int().min(0), count: z.number() }),
  private: z.null(),
});
export const readBootstrap = bootstrapEnvelope.extend({ snapshot: readSnapshot });
const event = eventEnvelope.extend({
  payload: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("change"), change: z.object({ count: z.number() }) }),
    z.object({ kind: z.literal("result"), result: z.object({ kind: z.literal("done") }) }),
  ]),
});
export const readBatch = batchEnvelope.extend({ events: z.array(event) });
export const streamMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("changes"), events: z.array(event).max(100) }),
  z.object({ kind: z.literal("account-change") }),
]);
TS
  cat > src/backend/bump.ts <<'TS'
import { operation } from "@tinker/core";
import { eventHistory } from "@tinker/start/server";
import { database } from "../lib/tinker.server.ts";
export const bump = operation({
  label: "bump",
  depends: { database, history: eventHistory },
  run: async ({ database, history }, { random }) =>
    database.transaction(async (tx) => {
      const revision = await history.lock(tx, "public");
      await history.append(tx, "public", random.uuid(), [
        { kind: "change", change: { count: revision + 1 } },
      ]);
      return revision + 1;
    }),
});
TS
  cat > src/routes/__root.tsx <<'TS'
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { Sync } from "@tinker/start";
export const Route = createRootRouteWithContext<Sync.RouterContext>()({
  component: () => <Outlet />,
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ),
});
TS
  cat > src/routes/index.tsx <<'TS'
import { createFileRoute } from "@tanstack/react-router";
import { useData } from "@tinker/react";
import { count } from "../frontend/count.ts";
function Count() {
  return <p>count {useData(count)}</p>;
}
export const Route = createFileRoute("/")({
  loader: ({ context }) => context.bootstrap(),
  component: Count,
});
TS
  cat > src/routes/api.bump.ts <<'TS'
import { createFileRoute } from "@tanstack/react-router";
import { startRequests } from "@tinker/start";
import { readResult } from "@tinker/start/server";
import { bump } from "../backend/bump.ts";
export const Route = createFileRoute("/api/bump")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      POST: async ({ context }) =>
        Response.json({ count: readResult(await context.session.settle(bump, {})) }),
    },
  },
});
TS
  rm -f src/backend/greet.ts
  node node_modules/@tinker/start/bin/tinker.mjs prepare > /dev/null 2>&1
}
browse() {
  say "agent-browser $*"
  timeout 60 agent-browser $browser_flags --session "$browser_session" "$@" 2>&1 | tail -3
}

{
  mistake "sync on, client side: the server render, the tab, and its stream"
  syncApp
  rport=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  rm -f "$scratch/received-sync.txt"
  node "$scratch/receiver.mjs" "$rport" "$scratch/received-sync.txt" &
  receiver=$!
  printf 'VICTORIA_TRACES_URL=http://127.0.0.1:%s/traces\nVICTORIA_LOGS_URL=http://127.0.0.1:%s/logs\n' "$rport" "$rport" >> .env
  build
  say "cat .tinker/parts.ts"
  cat .tinker/parts.ts
  doctor
  serve_up
  say "curl -s :PORT/ | grep -ao '<p>count[^<]*<!-- -->[0-9]*</p>'  (getBootstrap, in the server render)"
  curl -s "http://127.0.0.1:$port/" | grep -ao '<p>count[^<]*<!-- -->[0-9]*</p>'
  sleep 2
  say "storage: spans so far"
  grep -ao '"name":"[a-zA-Z.]*","kind"' "$scratch/received-sync.txt" | cut -d'"' -f4 | sort | uniq -c
  browser_session="sync-tab-$$"
  browser_flags="${SYNC_BROWSER_FLAGS:-}"
  echo "browser engine: ${browser_flags:-lightpanda (the default)}"
  browse open "http://127.0.0.1:$port/"
  sleep 3
  browse eval 'document.querySelector("p")?.textContent'
  say "curl -s -X POST :PORT/api/bump  (a commit after the tab loaded)"
  curl -s -X POST -H "origin: http://127.0.0.1:$port" "http://127.0.0.1:$port/api/bump"; echo
  sleep 3
  browse eval 'document.querySelector("p")?.textContent'
  browse close
  serve_down
  kill "$receiver"
  say "storage: every span name, after the tab"
  grep -ao '"name":"[a-zA-Z.]*","kind"' "$scratch/received-sync.txt" | cut -d'"' -f4 | sort | uniq -c

  mistake "sync on, and a client seam without streamMessage: the build stops"
  syncApp
  sed -i 's/^export const streamMessage = /const streamMessage = /' src/lib/tinker.ts
  build
  doctor

  mistake "sync on, and no Register bodies: the build stops"
  syncApp
  sed -i '/^declare module "@tinker\/start" {/,/^}/d' src/lib/tinker.ts
  build
  doctor
} 2>&1 | clean > "$out/15-sync-client.txt"

cd "$repo"
grep -H "EXIT\|^fail\|tinker doctor," "$out"/8-*.txt "$out"/9-*.txt "$out"/10-*.txt "$out"/11-*.txt "$out"/12-*.txt "$out"/13-*.txt "$out"/14-*.txt "$out"/15-*.txt | cut -c1-150
