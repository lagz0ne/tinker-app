# Issue board CUJ: rules over the graph

The CUJ does not match a golden file (ADR 0161,
amended 2026-11-17). More than one good shape
can exist. Each rule below answers OK, or names a
violation at a file and line.

Inputs for every rule:

- the app's `tinker.graph`: one line per op,
  facts only;
- the given contract (`src/issues/contract.ts`);
- for a judged rule, also the op's code.

## Fact rules: plain code over the graph

F1. Each call op that names a team calls
`issues.inTeam`. `team.create.do` is the one
exception: its team does not exist yet.

```text
team.add.do      calls{issues.inTeam}
issue.create.do  calls{issues.inTeam}
issue.move.do    calls{issues.inTeam}
comment.add.do   calls{issues.inTeam}
```

F2. The read start hook calls `issues.inTeam`.

```text
issues.membersOnly calls{issues.inTeam}
```

F3. The start hooks and the check write nothing.

```text
issues.signedIn     writes{}
issues.membersOnly  writes{}
issues.inTeam       writes{}
```

F4. Each cell has only these writers:

- `issues.members`: `team.create.do`,
  `team.add.do`;
- `issues.list`: `issue.create.do`,
  `issue.move.do`;
- `issues.comments`: `comment.add.do`.

F5. Each op's `exits` equal its answer kinds in
the contract, plus `refused` for a start hook.

## Judged rules: the LLM reads graph and code

J1. An answer of `gone`, `stale` or `exists`
writes nothing. (S1, S3, S5)

J2. The read hook refuses a non-member for each
part: members, issues and comments. (S5)

J3. Issue numbers count within one team. (S2)

J4. A move is `stale` for any version other than
the one stored now. (S3)

J5. An issue is found by team and id. Another
team's issue is `gone`. (S5)

J6. The member check runs before any issue is
read. (S5, S7)

J7. A comment's author is the caller, never a
field of the input. (S4)

The judge answers each rule with OK or a
violation, the file and line, and one sentence of
why. It judges only what the code does. It does
not judge names or style.

## Each seeded fault must break a rule

- M1: a stale move writes the state anyway → J1.
- M2: `team.create` on a team that exists adds
  the caller → J1.
- M3: `membersOnly` guards the issues part
  only → J2.
- M4: numbers count over all teams → J3.
- M5: a version the server never had is not
  `stale` → J4.
- M6: a comment on another team's issue is
  added → J5.
- Removing the member check from a call → F1.
- A hook that writes a cell → F3.

The golden must pass every rule.
