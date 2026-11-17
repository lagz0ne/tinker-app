// rules-check.mjs <tinker.graph>: the issue board CUJ's fact rules (rules.md F1-F4), plain code
// over the graph's facts. Prints one line per rule: OK, or each violation. Exit 1 on a violation.
// The graph line: `<label> exits{a,b} reads{x} writes{y} calls{z}` (ADR 0161, amended 2026-11-17).
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node rules-check.mjs <tinker.graph>");
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
    if (!label) return;
    ops.set(label, {
      at: `${file}:${i + 1}`,
      reads: set(line, "reads"),
      writes: set(line, "writes"),
      calls: set(line, "calls"),
    });
  });

const CHECK = "issues.inTeam";
const rules = {
  F1: {
    say: "each call op that names a team calls issues.inTeam (team.create.do excepted)",
    ops: ["team.add.do", "issue.create.do", "issue.move.do", "comment.add.do"],
    test: (op) => op.calls.has(CHECK) || `calls{${[...op.calls]}} has no ${CHECK}`,
  },
  F2: {
    say: "the read start hook calls issues.inTeam",
    ops: ["issues.membersOnly"],
    test: (op) => op.calls.has(CHECK) || `calls{${[...op.calls]}} has no ${CHECK}`,
  },
  F3: {
    say: "the start hooks and the check write nothing",
    ops: ["issues.signedIn", "issues.membersOnly", "issues.inTeam"],
    test: (op) => op.writes.size === 0 || `writes{${[...op.writes]}}`,
  },
};

const writers = {
  "issues.members": ["team.create.do", "team.add.do"],
  "issues.list": ["issue.create.do", "issue.move.do"],
  "issues.comments": ["comment.add.do"],
};

let bad = 0;
for (const [id, rule] of Object.entries(rules)) {
  const out = rule.ops.flatMap((label) => {
    const op = ops.get(label);
    if (!op) return [`${label}: not in the graph`];
    const r = rule.test(op);
    return r === true ? [] : [`${op.at} ${label}: ${r}`];
  });
  bad += out.length;
  console.log(out.length ? `${id} VIOLATION (${rule.say})\n  ${out.join("\n  ")}` : `${id} OK`);
}

const f4 = [];
for (const [label, op] of ops) {
  for (const w of op.writes) {
    const cell = Object.keys(writers).find((c) => w.startsWith(`${c}.`));
    if (cell && !writers[cell].includes(label)) f4.push(`${op.at} ${label}: writes ${w}`);
  }
}
bad += f4.length;
console.log(f4.length ? `F4 VIOLATION (each cell has only its listed writers)\n  ${f4.join("\n  ")}` : "F4 OK");

process.exit(bad ? 1 : 0);
