#!/usr/bin/env bash
# The hardened base's proof (ADR 0106), from the repo root, after vp install && vp run -r build.
# 8: apps/start-min on the workspace link: build, serve, curl, doctor.
# 9: each known silent mistake, in a scratch copy of apps/start-min on the packed base:
#    vp build stops with doctor's file:line message, or doctor names it.
# 10: what the base now does: named files, style, public/, .env, prod errors.
# 11: a fresh clone: tinker prepare (the postinstall) writes the route tree; tsc passes.
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

cd "$repo"
grep -H "EXIT\|^fail\|tinker doctor," "$out"/8-*.txt "$out"/9-*.txt "$out"/10-*.txt "$out"/11-*.txt | cut -c1-150
