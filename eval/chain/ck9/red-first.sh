#!/usr/bin/env bash
# red-first.sh <before-tree> <after-tree> <out-dir>: the ck9 gate on the writer's own test.
#
# <before-tree> is the tree as the step started (the commit the runner made before the writer).
# <after-tree> is the tree when the writer ends. The writer's test is `tests/bug.test.ts` in
# <after-tree> (TASK ck9 names the file).
#
# OK when both hold:
#  - red: the file, copied into a copy of <before-tree>, loads and has at least one failed test;
#  - green: in a copy of <after-tree>, every test of the file passes.
# A file that does not load on the old tree (it imports a file the fix made) is not red.
# Prints one line, and writes red-first.json. Exit 0 = OK.
set -u
B=$(cd "${1:?before}" && pwd); A=$(cd "${2:?after}" && pwd); OUT=${3:?out}
export VP_NODE_VERSION=${VP_NODE_VERSION:-24.22.1}
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
F=tests/bug.test.ts
[ -f "$A/$F" ] || { echo "{\"redFirst\":false,\"why\":\"no $F\"}" | tee "$OUT/red-first.json"; exit 1; }
TMP=$(mktemp -d -p "$OUT"); trap 'rm -rf "$TMP"' EXIT

run() { # run <tree> <report>: copy the tree, put the writer's file in, run it.
  mkdir -p "$TMP/t" && rm -rf "$TMP/t"/* "$TMP/t"/.[!.]* 2>/dev/null
  (cd "$1" && tar -cf - --exclude=./node_modules --exclude=./.git --exclude=./dist \
    --exclude=./.tinker --exclude=./.vitest .) | (cd "$TMP/t" && tar -xf -)
  cp "$A/$F" "$TMP/t/$F"
  (cd "$TMP/t" && bun install --frozen-lockfile >/dev/null 2>&1 &&
    timeout 300 bun --bun vp test --project server "$F" --reporter=json --outputFile="$2" \
      >"$2.log" 2>&1)
  node -e '
    let r; try { r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")) } catch { console.log("0 0"); process.exit() }
    const all = r.testResults.flatMap((f) => f.assertionResults);
    console.log(all.length + " " + all.filter((t) => t.status === "failed").length);
  ' "$2"
}

read -r bn bf < <(run "$B" "$OUT/before.json")
read -r an af < <(run "$A" "$OUT/after.json")
red=$([ "$bn" -gt 0 ] && [ "$bf" -gt 0 ] && echo true || echo false)
green=$([ "$an" -gt 0 ] && [ "$af" = 0 ] && echo true || echo false)
ok=$([ $red = true ] && [ $green = true ] && echo true || echo false)
echo "{\"redFirst\":$ok,\"before\":\"$bf of $bn failed\",\"after\":\"$af of $an failed\",\"red\":$red,\"green\":$green}" |
  tee "$OUT/red-first.json"
[ $ok = true ]
