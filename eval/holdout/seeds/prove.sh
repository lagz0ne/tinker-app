#!/usr/bin/env bash
# Prove one seed: prove.sh <golden-tree> <seed.patch>
# Applies the seed to a clean golden tree (make-tree.sh golden hbN), runs the step's two hidden
# test files, then takes the seed out again. Prints the failed test names. A seed is caught when
# at least one hidden test fails. Exit 0 = caught, 1 = missed, 2 = setup error.
set -u
tree=${1:?golden tree}; seed=$(cd "$(dirname "${2:?seed}")" && pwd)/$(basename "$2")
cd "$tree" || exit 2
git diff --quiet || { echo "prove.sh: $tree is not clean" >&2; exit 2; }
git apply "$seed" || { echo "prove.sh: the seed does not apply" >&2; exit 2; }
out=$(bun --bun vp test tests/rooms-feature.test.ts tests/browser/room-booking.test.tsx 2>&1)
git apply -R "$seed"
printf '%s\n' "$out" | grep -E "^ +(×|✗|FAIL)| Tests " | sed 's/^ *//'
printf '%s\n' "$out" | grep -qE "Tests .*[0-9]+ failed" && { echo "caught: $(basename "$seed")"; exit 0; }
echo "missed: $(basename "$seed")"; exit 1
