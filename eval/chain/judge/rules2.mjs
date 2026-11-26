// rules2.mjs <tinker.graph> <step 1|2|3|4>: the chain's fact rules F1-F4, plain code over the graph.
// From run 10's rules-check.mjs. Changes (cuj11):
//  - F1 follows calls transitively: an op passes when issues.inTeam is in the closure of its calls.
//  - ck2: issue.rename.do joins F1 and the issues.list writers (TASK ck2 R1, R4, R6).
//  - ck3: comment.add.do leaves F1; team.archive.do joins it; issues.archived has one writer,
//         team.archive.do; issues.comments has none (TASK ck3: comments go).
// cuj13 (run 13): step 4 = step 3 (TASK ck4 adds no op and no cell).
// cuj16 (run 16): steps 5-8 (steps 1-4 as run 15). F1 adds issue.label.do (ck5), issue.assign.do (ck6),
//  team.delete.do (ck8). F2's text lists the parts of the step (R2). F4 at ck5+: a write counts for each
//  op with no caller (a call op or a hook) that reaches it through its calls, so a helper such as
//  issues.record is judged by the ops that call it. Writers: labels (ck5), issues.list + label/assign,
//  events (ck7: the issue changes), team.delete.do writes every team cell (ck8). rules2-run15.mjs = before.
// v2 (ck9, ck10): steps 9 and 10 judge as step 8, with one change. ck9: a person made a viewer is
//  taken off each issue, so team.add.do writes issues.list and issues.events (through issues.record).
//  ck10 adds no writer of a listed cell: the outbox is the writer's own cell, not judged here.
//  ck11 (step 11): a deleted team's parts go later, from a root the server starts (not a call op, not a
//  start hook). Such a root may only `.delete` members of the team cells.
const HOOKS = ["issues.signedIn", "issues.membersOnly"];
const sweeps = (label, w) =>
  step >= 11 && !label.endsWith(".do") && !HOOKS.includes(label) && w.endsWith(".delete");
import { readFileSync } from "node:fs";

const [file, stepArg] = process.argv.slice(2);
const step = Number(stepArg);
if (!file || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(step)) {
  console.error("usage: node rules2.mjs <tinker.graph> <step 1-11>");
  process.exit(2);
}
const set = (line, name) => {
  const m = line.match(new RegExp(`${name}\\{([^}]*)\\}`));
  return new Set(m && m[1] ? m[1].split(",") : []);
};
const ops = new Map();
readFileSync(file, "utf8")
  .split(/\r?\n/)
  .forEach((line, i) => {
    const label = line.trim().split(/\s+/)[0];
    if (!label || label === "view") return; // 0.34.10: view lines are pages, not ops
    ops.set(label, {
      at: `${file}:${i + 1}`,
      reads: set(line, "reads"),
      writes: set(line, "writes"),
      calls: set(line, "calls"),
    });
  });
const closure = (label) => {
  const seen = new Set(),
    todo = [...(ops.get(label)?.calls ?? [])];
  while (todo.length) {
    const c = todo.pop();
    if (seen.has(c)) continue;
    seen.add(c);
    todo.push(...(ops.get(c)?.calls ?? []));
  }
  return seen;
};
const CHECK = "issues.inTeam";
const viaCheck = (label, op) => {
  const all = closure(label);
  if (all.has(CHECK)) return true;
  return `calls{${[...op.calls]}} (all: ${[...all].join(",") || "none"}) reach no ${CHECK}`;
};
const f1 = {
  1: ["team.add.do", "issue.create.do", "issue.move.do", "comment.add.do"],
  2: ["team.add.do", "issue.create.do", "issue.move.do", "issue.rename.do", "comment.add.do"],
  3: ["team.add.do", "issue.create.do", "issue.move.do", "issue.rename.do", "team.archive.do"],
}[Math.min(step, 3)].slice();
if (step >= 5) f1.push("issue.label.do");
if (step >= 6) f1.push("issue.assign.do");
if (step >= 8) f1.push("team.delete.do");
const PARTS =
  step >= 7
    ? "members, issues, archived, labels, events"
    : step >= 5
      ? "members, issues, archived, labels"
      : step >= 3
        ? "members, issues, archived"
        : "members, issues, comments";
const rules = {
  F1: {
    say: "each call op that names a team calls issues.inTeam, directly or through its calls (team.create.do excepted)",
    ops: f1,
    test: viaCheck,
  },
  F2: {
    say:
      step >= 5
        ? `the read start hook calls issues.inTeam (R2 parts: ${PARTS})`
        : "the read start hook calls issues.inTeam",
    ops: ["issues.membersOnly"],
    test: viaCheck,
  },
  F3: {
    say: "the start hooks and the check write nothing",
    ops: ["issues.signedIn", "issues.membersOnly", "issues.inTeam"],
    test: (_, op) => op.writes.size === 0 || `writes{${[...op.writes]}}`,
  },
};
const writers = {
  1: {
    "issues.members": ["team.create.do", "team.add.do"],
    "issues.list": ["issue.create.do", "issue.move.do"],
    "issues.comments": ["comment.add.do"],
  },
  2: {
    "issues.members": ["team.create.do", "team.add.do"],
    "issues.list": ["issue.create.do", "issue.move.do", "issue.rename.do"],
    "issues.comments": ["comment.add.do"],
  },
  3: {
    "issues.members": ["team.create.do", "team.add.do"],
    "issues.list": ["issue.create.do", "issue.move.do", "issue.rename.do"],
    "issues.archived": ["team.archive.do"],
    "issues.comments": [],
  },
}[Math.min(step, 3)];
if (step >= 5) {
  const changes = [
    "issue.create.do",
    "issue.move.do",
    "issue.rename.do",
    "issue.label.do",
    ...(step >= 6 ? ["issue.assign.do"] : []),
  ];
  writers["issues.list"] = changes.slice();
  writers["issues.labels"] = ["issue.label.do"];
  if (step >= 7) writers["issues.events"] = changes.slice();
  delete writers["issues.comments"];
  if (step >= 8) for (const c of Object.keys(writers)) writers[c].push("team.delete.do");
  if (step >= 9) for (const c of ["issues.list", "issues.events"]) writers[c].push("team.add.do");
}
let bad = 0;
for (const [id, rule] of Object.entries(rules)) {
  const out = rule.ops.flatMap((label) => {
    const op = ops.get(label);
    if (!op) return [`${label}: not in the graph`];
    const r = rule.test(label, op);
    return r === true ? [] : [`${op.at} ${label}: ${r}`];
  });
  bad += out.length;
  console.log(out.length ? `${id} VIOLATION (${rule.say})\n  ${out.join("\n  ")}` : `${id} OK`);
}
const f4 = [];
if (step < 5)
  for (const [label, op] of ops)
    for (const w of op.writes) {
      const cell = Object.keys(writers).find((c) => w.startsWith(`${c}.`));
      if (cell && !writers[cell].includes(label)) f4.push(`${op.at} ${label}: writes ${w}`);
    }
else {
  const called = new Set([...ops.values()].flatMap((o) => [...o.calls]));
  for (const [label, op] of ops) {
    if (called.has(label)) continue;
    for (const o of [label, ...closure(label)])
      for (const w of ops.get(o)?.writes ?? []) {
        const cell = Object.keys(writers).find((c) => w.startsWith(`${c}.`));
        if (cell && !writers[cell].includes(label) && !sweeps(label, w))
          f4.push(`${op.at} ${label}: writes ${w}${o === label ? "" : ` (through ${o})`}`);
      }
  }
}
bad += f4.length;
console.log(
  f4.length
    ? `F4 VIOLATION (each cell has only its listed writers)\n  ${f4.join("\n  ")}`
    : "F4 OK",
);
process.exit(bad ? 1 : 0);
