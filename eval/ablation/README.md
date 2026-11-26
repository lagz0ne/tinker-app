# Ablation arms (run 21 on)

Duke, 2026-11-26: find where Tinker breaks. The same
train chain (`eval/chain`, ck1 to ck8), with less of
Tinker's help:

- A: the full kit (as run 20).
- B: no skills.
- C: no skills and no `tinker check` ("bare").

`overlay.sh` makes a B or C tree; `MANIFEST.md` lists
each change. The holdout (`eval/holdout`) never runs
with an overlay.

The primary score of each arm: the furthest step 0 to
8 where all hidden tests pass and the given files are
byte-equal. The strict score (judge, `tinker check`,
style, typecheck) is a fact.
