#!/usr/bin/env bash
# run.sh <tree> <out.json>: copy adv.test.ts into the tree's tests/, run it, take it out. The tree needs node_modules.
T=$1; O=$2; export VP_NODE_VERSION=24.22.1
cp "$(dirname "$0")/adv.test.ts" "$T/tests/adv.test.ts"
(cd "$T" && timeout 300 bun --bun vp test --project server tests/adv.test.ts --reporter=json --outputFile="$O" >"$O.log" 2>&1)
rm -f "$T/tests/adv.test.ts"
node -e 'const r=require(process.argv[1]);for(const t of r.testResults.flatMap(f=>f.assertionResults))console.log(t.status.padEnd(7),t.title)' "$O"
