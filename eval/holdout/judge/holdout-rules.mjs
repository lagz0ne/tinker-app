// holdout-rules.mjs <tinker.graph> <step 1-4>: the holdout (room booking) rules R1-R3, plain code over the graph.
// From the issue chain's rules2.mjs (F1-F3). `view` lines (0.34.10) are pages, not ops.
//  R1 each call op that names an office reaches rooms.inOffice (directly or through its calls);
//     office.create.do is the exception, and it reads only rooms.members.
//  R2 the read hook rooms.membersOnly calls rooms.inOffice.
//  R3 the start hooks (rooms.signedIn, rooms.membersOnly) and rooms.inOffice write nothing.
import { readFileSync } from "node:fs";

const [file, stepArg] = process.argv.slice(2);
const step = Number(stepArg);
if (!file || ![1, 2, 3, 4].includes(step)) {
  console.error("usage: node holdout-rules.mjs <tinker.graph> <step 1-4>");
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
    if (!label || label === "view") return;
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
const CHECK = "rooms.inOffice";
const calls = ["member.add.do", "room.add.do", "booking.make.do"];
if (step >= 2) calls.push("booking.cancel.do");
if (step >= 4) calls.push("room.remove.do");
let bad = 0;
const say = (id, text, out) => {
  bad += out.length;
  console.log(out.length ? `${id} VIOLATION (${text})\n  ${out.join("\n  ")}` : `${id} OK`);
};
const r1 = calls.flatMap((l) => {
  const op = ops.get(l);
  if (!op) return [`${l}: not in the graph`];
  return closure(l).has(CHECK) ? [] : [`${op.at} ${l}: calls{${[...op.calls]}} reach no ${CHECK}`];
});
const oc = ops.get("office.create.do");
if (!oc) r1.push("office.create.do: not in the graph");
else
  for (const r of oc.reads)
    if (!r.startsWith("rooms.members."))
      r1.push(`${oc.at} office.create.do reads ${r} (only members)`);
say("R1", `each call that names an office reaches ${CHECK}; office.create reads only members`, r1);
const mo = ops.get("rooms.membersOnly");
say(
  "R2",
  `the read hook calls ${CHECK}`,
  !mo
    ? ["rooms.membersOnly: not in the graph"]
    : closure("rooms.membersOnly").has(CHECK)
      ? []
      : [`${mo.at} rooms.membersOnly: calls{${[...mo.calls]}} reach no ${CHECK}`],
);
const r3 = ["rooms.signedIn", "rooms.membersOnly", CHECK].flatMap((l) => {
  const op = ops.get(l);
  if (!op) return [`${l}: not in the graph`];
  const w = [op.writes, ...[...closure(l)].map((c) => ops.get(c)?.writes ?? new Set())].flatMap(
    (s) => [...s],
  );
  return w.length ? [`${op.at} ${l}: writes{${w}}`] : [];
});
say("R3", "the start hooks and the member check write nothing", r3);
process.exit(bad ? 1 : 0);
