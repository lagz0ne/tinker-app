#!/usr/bin/env bash
# Score one writer's tree on rung A (issue board, contract given).
# usage: score.sh <app-dir>   -> prints one JSON line; logs in <app-dir>/.cuj/
#
# The writer's tree is never changed: every gate runs in a copy (only the logs
# land in <app-dir>/.cuj/). So the template itself can be scored, and a writer's
# own test with the hidden test's file name is kept.
#
# Gates (all external; the writer never sees the hidden tests). Each gate's own
# exit code is in the JSON, so a red gate is never read as green:
#   check     tinker check = OK (types, lint, rules, the writer's tests, exits)
#   journeys  hidden CUJ tests, under their own file names
#   types     tsc --noEmit, with the hidden tests in the tree
#   shape     shape.mjs src/issues vs golden.yaml
#   given     every file of the task commit is unchanged (TASK.md aside), and
#             contract.ts, sign-in.ts, index.ts are byte-equal to the kit's
#   style     bun run check:style (TASK.md "Done means"); recorded, not in golden
set -u
if [ -z "${1:-}" ] || [ ! -f "$1/package.json" ] || [ ! -d "$1/src/issues" ]; then
  echo "usage: score.sh <app-dir>   (an app tree with src/issues)" >&2; exit 2
fi
APP=$(cd "$1" && pwd); HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$APP/.cuj; rm -rf "$OUT"; mkdir -p "$OUT"
TMP=$(mktemp -d); WORK=$TMP/tree; mkdir -p "$WORK"
trap 'rm -rf "$TMP"' EXIT
(cd "$APP" && tar -cf - --exclude=./node_modules --exclude=./.git --exclude=./.cuj \
  --exclude=./dist --exclude=./.tinker --exclude=./.vitest .) | (cd "$WORK" && tar -xf -)
(cd "$WORK" && bun install --frozen-lockfile >"$OUT/install.log" 2>&1) || { echo "{\"app\":\"$APP\",\"error\":\"bun install failed, see .cuj/install.log\"}"; exit 2; }

# given: a file the task gave was changed or removed (git tree), or differs from the kit.
given=""
if [ -d "$APP/.git" ]; then
  ROOT=$(git -C "$APP" rev-list --max-parents=0 HEAD | tail -1)
  given=$(git -C "$APP" diff --name-only --diff-filter=MDRT "$ROOT" -- . ':!TASK.md' | tr '\n' ' ')
fi
for f in contract.ts sign-in.ts index.ts; do
  cmp -s "$APP/src/issues/$f" "$HERE/given/$f" || given="$given src/issues/$f(kit)"
done
given=$(echo $given)
c=$([ -z "$given" ] && echo 0 || echo 1)

cd "$WORK"
# The check runs first, with the writer's own tests only: its exits stage (ADR 0159)
# must pass by them, not by the hidden tests.
bun scripts/embed-client.ts >/dev/null 2>&1
bun --bun tinker check >"$OUT/check.log" 2>&1; a=$?
# The check shows 5 findings and counts them all in its last lines: take its own count.
findings=$(grep -o '[0-9]* findings' "$OUT/check.log" | tail -1 | cut -d' ' -f1)
findings=${findings:-$(grep -c ' tinker/' "$OUT/check.log")}
stage=$(grep -o 'tinker check: [a-z]* failed' "$OUT/check.log" | tail -1 | cut -d' ' -f3)
bun run check:style >"$OUT/style.log" 2>&1; st=$?

cp "$HERE/hidden/issues-feature.test.ts" tests/cuj-hidden-feature.test.ts
cp "$HERE/hidden/issue-board.test.tsx" tests/browser/cuj-hidden-board.test.tsx
for try in 1 2 3 4 5; do
  rm -f "$OUT/journeys.json"
  bun --bun vp test --project server tests/cuj-hidden-feature.test.ts \
    --project browser tests/browser/cuj-hidden-board.test.tsx \
    --reporter=json --outputFile="$OUT/journeys.json" >"$OUT/journeys.log" 2>&1; j=$?
  grep -q "already in use" "$OUT/journeys.log" || break; sleep $((RANDOM % 20 + 5))
done
# No report file means the run broke before any test: say so, not "0 passed".
pass=$(node -e '
  let r; try { r = require(process.argv[1]) } catch { console.log("error: no report"); process.exit() }
  const bad = r.testResults.flatMap((f) => f.assertionResults.filter((t) => t.status !== "passed").map((t) => t.title));
  const broke = r.testResults.filter((f) => f.status !== "passed" && !f.assertionResults.length).length;
  require("fs").writeFileSync(process.argv[2], bad.join("\n") + (bad.length ? "\n" : ""));
  console.log(r.numPassedTests + "/" + r.numTotalTests + (broke ? " (" + broke + " file did not load)" : ""));
' "$OUT/journeys.json" "$OUT/journeys-failed.txt")
# Green only when every hidden journey ran and passed: the count comes from the hidden files.
want=$(cat "$HERE"/hidden/*.test.ts* | grep -c '^test(')
[ "$pass" = "$want/$want" ] || j=1

bun run typecheck >"$OUT/types.log" 2>&1; t=$?
TOOLS=${CUJ_TOOLS:-$HOME/.cuj-tools}
[ -d "$TOOLS/node_modules/typescript" ] || (mkdir -p "$TOOLS" && cd "$TOOLS" && npm i --silent typescript@5.9.3 >/dev/null)
cp "$HERE/shape.mjs" "$TOOLS/"
node "$TOOLS/shape.mjs" src/issues "$HERE/golden.yaml" >"$OUT/shape.log" 2>&1; s=$?
shape=$(tail -1 "$OUT/shape.log" | tr -d '"')

# Since run 5 (ADR 0161 amended): the shape is recorded, not a gate. More than one good shape
# can exist; the rules (judge.md, judged outside this script) take its place.
golden=$([ "$j$a$t$c" = "0000" ] && echo true || echo false)
echo "{\"app\":\"$APP\",\"journeys\":\"$pass\",\"journeys_exit\":$j,\"check_exit\":$a,\"check_failed_stage\":\"${stage:-}\",\"findings\":$findings,\"types\":$t,\"shape\":\"$shape\",\"shape_exit\":$s,\"given_changed\":\"$given\",\"style\":$st,\"golden\":$golden}"
