#!/usr/bin/env bash
# Build one holdout tree: make-tree.sh <start|golden> <hbN> <out-dir>
#   start  hb1:  the writer's start tree (base + given of hb1 + TASK.md). Only hb1 has a start:
#                a later step runs on the writer's own tree (README "Run one chain").
#   golden hbN:  the golden tree of step N (base + given hb1..hbN + golden/ of hbN + hidden tests).
# Base = tinker-app 20b7954 (chain kit, @tinkered/* 0.34.10) with the issue board taken out.
#   PORT=<n>    the tree's browser test port (default: 63400 + a hash of the path, as make-task.sh)
#   NO_INSTALL=1  skip `bun install`
# <out-dir> must not exist yet: this script removes nothing outside it.
set -eu
kind=${1:?start|golden}; step=${2:?hbN}; OUT=${3:?out-dir}
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd); BASE=20b7954
n=${step#hb}
case "$kind:$n" in start:1 | golden:[1-4]) ;; *) echo "usage: make-tree.sh <start hb1|golden hb1..hb4> <out>" >&2; exit 2 ;; esac
if [ -e "$OUT" ]; then echo "make-tree.sh: $OUT exists" >&2; exit 2; fi
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
git -C "$REPO" archive "$BASE" | tar -x -C "$OUT"
cd "$OUT"
# The issue board goes: its feature, its tests, its graph, its README section, the kit.
rm -r src/issues eval tests/issues-feature.test.ts tests/browser/issue-board.test.tsx tinker.graph
awk '/^## A second feature: the issue board/ { skip = 1; next } /^## / { skip = 0 } !skip' \
  README.md >README.md.new && mv README.md.new README.md
cp "$HERE/start/tinker.json" tinker.json
for i in $(seq 1 "$n"); do cp -r "$HERE/hb$i/given/." .; done
if [ "$kind" = start ]; then
  cp "$HERE/hb1/TASK.md" TASK.md
else
  cp -r "$HERE/$step/golden/." .
  cp "$HERE/$step/hidden/rooms-feature.test.ts" tests/
  cp "$HERE/$step/hidden/room-booking.test.tsx" tests/browser/
fi
PORT=${PORT:-$((63400 + $(printf %s "$OUT" | cksum | cut -d' ' -f1) % 500))}
sed -i "s|name: \"browser\",|name: \"browser\",\n          api: { port: $PORT, strictPort: true },|" vite.config.ts
grep -q "api: { port: $PORT, strictPort: true }" vite.config.ts || { echo "make-tree.sh: the port patch did not apply" >&2; exit 1; }
git init -q && git add -A && git -c user.name=task -c user.email=task@local commit -qm "holdout: $kind $step"
[ -n "${NO_INSTALL:-}" ] || bun install >/dev/null 2>&1 || { echo "make-tree.sh: bun install failed in $OUT" >&2; exit 1; }
echo "$OUT ready ($kind $step, browser port $PORT)"
