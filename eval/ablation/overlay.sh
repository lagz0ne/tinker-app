#!/usr/bin/env bash
# Ablation overlay for the CUJ train chain (eval/chain), arms B and C. Never for the holdout.
#   overlay.sh <B|C> start <tree>   the start tree, after `bun install`: skills out (B, C); check out (C)
#   overlay.sh <B|C> step <N> <tree> the step's TASK.md, after the kit copied it in (N = 1 to 8)
#   overlay.sh <B|C> guard <tree>   after a writer session: exit 1 when a Tinker skill (or, in C, the real
#                                    `tinker` bin) is back in node_modules
# Arm A (full kit) uses no overlay. Kit files are never edited: the overlay edits the writer's tree only.
# Every text edit matches its text (not a line number) and fails loudly when the text is not there.
# See MANIFEST.md for each change.
set -eu
arm=${1:?B|C}; mode=${2:?start|step|guard}
case "$arm" in B | C) ;; *) echo "overlay.sh: arm is B or C" >&2; exit 2 ;; esac

strip_node_modules() { # $1 = tree
  rm -rf "$1/node_modules/@tinkered/core/skills"
  rm -f "$1/node_modules/@tinkered/react/skills/react/SKILL.md" "$1/node_modules/@tinkered/cli/README.md"
  if [ "$arm" = C ]; then
    rm -f "$1/node_modules/.bin/tinker"
    printf '#!/bin/sh\necho "tinker: not available in this run" >&2\nexit 1\n' > "$1/node_modules/.bin/tinker"
    chmod +x "$1/node_modules/.bin/tinker"
  fi
}

edit() { # edit <file> <python body that changes s>; the body asserts its anchors
  python3 -I - "$1" "$2" <<'PY'
import sys
p, body = sys.argv[1], sys.argv[2]
s = open(p).read()
def cut(a, b=""):
    global s
    if s.count(a) != 1: sys.exit(f"overlay: {p}: text not found once: {a[:60]!r}")
    s = s.replace(a, b)
def cut_block(start, end):  # from the line `start` to the line `end`, both in
    global s
    i = s.find(start); j = s.find(end, i)
    if i < 0 or j < 0 or s.count(start) != 1: sys.exit(f"overlay: {p}: block not found: {start[:40]!r}")
    s = s[:i] + s[j + len(end):]
exec(body)
open(p, "w").write(s)
PY
}

case "$mode" in
start)
  t=${3:?tree}
  strip_node_modules "$t"
  # AGENTS.md: the skill lines and the Skill Loading section.
  edit "$t/AGENTS.md" '
cut("The rules for Tinker code ship inside those\npackages as skills. A skill has the version of\nthe code you have installed.\n")
cut_block("<!-- intent-skills:start -->", "<!-- intent-skills:end -->\n\n")'
  # README.md: the skill lines.
  edit "$t/README.md" '
cut("  more: tinker skill load @tinkered/react#react\n")
cut_block("## For agents\n", "bunx intent load @tinkered/core#core/operation\n```\n\n")'
  if [ "$arm" = C ]; then
    # AGENTS.md: the check section becomes one line. package.json: no `check:plain`.
    edit "$t/AGENTS.md" '
i = s.find("## After you edit: run the check\n")
if i < 0: sys.exit("overlay: AGENTS.md: no check section")
s = s[:i] + "After you edit: `bun run check:style`, then `bun run check`.\n"'
    edit "$t/package.json" '
cut(",\n    \"check:plain\": \"bun scripts/embed-client.ts && bun --bun tinker check\"\n", "\n")'
  fi
  ;;
step)
  n=${3:?step}; t=${4:?tree}; f="$t/TASK.md"
  case "$n" in
  1)
    edit "$f" 'cut("Follow `AGENTS.md`. Load the Tinker skills first. Look at\n", "Follow `AGENTS.md`. Look at\n")'
    if [ "$arm" = C ]; then
      edit "$f" '
cut("`tinker.graph` is not here. Make it with `bunx tinker graph --write`.\n\n")
cut("- `bun run check:plain` prints `tinker check: OK`.\n")
cut_block("`tinker check` runs your tests. It fails for each exit\n", "test scope lists.\n\n")'
    fi ;;
  2)
    if [ "$arm" = C ]; then
      edit "$f" 'cut("The same as step 1: `tinker check: OK`,\n`check:style`, `bun run check`, and `RULES.md` all OK.\n", "The same as step 1: `check:style`,\n`bun run check`, and `RULES.md` all OK.\n")'
    fi ;;
  3 | 4 | 5 | 6 | 7 | 8)
    if grep -qiE 'tinker check|check:plain|skill' "$f"; then echo "overlay: $f names the check or a skill; add an edit" >&2; exit 3; fi ;;
  *) echo "overlay.sh: step is 1 to 8" >&2; exit 2 ;;
  esac
  strip_node_modules "$t" ;;
guard)
  t=${3:?tree}; bad=0
  s=$(find "$t/node_modules/@tinkered" -name SKILL.md 2>/dev/null)
  [ -z "$s" ] || { echo "guard: SKILL.md in node_modules: $s" | head -3; bad=1; }
  [ ! -e "$t/node_modules/@tinkered/cli/README.md" ] || { echo "guard: @tinkered/cli/README.md is back"; bad=1; }
  if [ "$arm" = C ] && [ -L "$t/node_modules/.bin/tinker" -o ! -e "$t/node_modules/.bin/tinker" ]; then echo "guard: the tinker stub is gone"; bad=1; fi
  exit $bad ;;
*) echo "overlay.sh: mode is start, step or guard" >&2; exit 2 ;;
esac
