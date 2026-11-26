#!/usr/bin/env bash
# Prove one chain seed: prove.sh <golden-tree> <step> <seed.patch>
# Copies the golden tree of that step (no node_modules), applies the seed, puts the step's hidden
# tests over the tree's own (as the scorer does), and runs them. The tree itself is not changed.
# Prints the failed test names. A seed is caught when at least one hidden test fails.
# Exit 0 = caught, 1 = missed, 2 = setup error.
set -u
tree=$(cd "${1:?golden tree}" && pwd); step=${2:?step}
seed=$(cd "$(dirname "${3:?seed}")" && pwd)/$(basename "$3")
K=$(cd "$(dirname "$0")/.." && pwd)/ck$step
export VP_NODE_VERSION=${VP_NODE_VERSION:-24.22.1}
TMP=$(mktemp -d -p "${SCRATCH:-$HOME}"); trap 'rm -rf "$TMP"' EXIT
(cd "$tree" && tar -cf - --exclude=./node_modules --exclude=./.git --exclude=./dist \
  --exclude=./.tinker --exclude=./.vitest .) | (cd "$TMP" && tar -xf -)
cd "$TMP" || exit 2
git apply "$seed" || { echo "prove.sh: the seed does not apply" >&2; exit 2; }
bun install --frozen-lockfile >/dev/null 2>&1 || { echo "prove.sh: install failed" >&2; exit 2; }
cp "$K/hidden/issues-feature.test.ts" tests/issues-feature.test.ts
cp "$K/hidden/issue-board.test.tsx" tests/browser/issue-board.test.tsx
out=$(bun --bun vp test --project server tests/issues-feature.test.ts \
  --project browser tests/browser/issue-board.test.tsx 2>&1)
printf '%s\n' "$out" | grep -E "^ +(×|✗|FAIL)| Tests " | sed 's/^ *//'
printf '%s\n' "$out" | grep -qE "Tests .*[0-9]+ failed" && { echo "caught: $(basename "$seed")"; exit 0; }
echo "missed: $(basename "$seed")"; exit 1
