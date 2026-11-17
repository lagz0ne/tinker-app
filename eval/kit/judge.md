# Judge brief: the issue board's judged rules

You are the LLM reader of a Tinker app's graph.
The graph is facts only: one line per op, with
its exits and every read, write and call in its
body. It does not say which write runs on which
exit. You judge that, from the code.

Read:

- the contract: `src/issues/contract.ts`;
- the server ops: `src/issues/ops.server.ts`;
- the graph lines given with this brief.

Judge each rule. Judge only what the code does.
Do not judge names, style or comments.

- J1. An answer of `gone`, `stale` or `exists`
  writes nothing.
- J2. The read hook refuses a non-member for each
  part: members, issues and comments.
- J3. Issue numbers count within one team.
- J4. A move is `stale` for any version other
  than the one stored now.
- J5. An issue is found by team and id. Another
  team's issue is `gone`.
- J6. The member check runs before any issue is
  read.
- J7. A comment's author is the caller, never a
  field of the input.

Answer with one JSON line per rule, nothing else:

```json
{"rule":"J1","verdict":"OK"}
{"rule":"J3","verdict":"VIOLATION",
 "at":"ops.server.ts:71",
 "why":"one sentence"}
```
