#!/usr/bin/env bash
# Start the built app on a free port, curl the page and two base routes, stop it.
# Usage: packages/start/scripts/curl-app.sh apps/start-min
set -euo pipefail
cd "$1"
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
PORT=$port node node_modules/@tinker/start/bin/tinker.mjs serve > /tmp/tinker-serve.log 2>&1 &
server=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$port/api/health" && break; sleep 0.2; done
echo "\$ curl -s http://127.0.0.1:$port/ | grep -ao '<p>[^<]*</p>'"
curl -s "http://127.0.0.1:$port/" | grep -ao '<p>[^<]*</p>' || true
echo "\$ curl -si http://127.0.0.1:$port/api/health"
curl -si "http://127.0.0.1:$port/api/health" | grep -iv '^date:\|^connection:\|^keep-alive:' | tr -d '\r'
echo
echo "\$ curl -s http://127.0.0.1:$port/tinker | grep -ao '<main>.*</main>'"
curl -s "http://127.0.0.1:$port/tinker" | grep -ao '<main>.*</main>' || true
kill -INT "$server"
wait "$server" && echo "server stopped: EXIT $?"
echo "server log, without the telemetry part's span lines ($(grep -ac '"msg":"core.span"' /tmp/tinker-serve.log) of them):"
grep -av '"msg":"core.span"' /tmp/tinker-serve.log
