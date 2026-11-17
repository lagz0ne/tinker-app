// probes.mjs <ops.server.ts>...: the issue board's judged rules (judge.md J1-J7) as Jev probe sets.
// Code picks each op block by its label; Jev answers small facts about it; this file joins them.
// Each rule has probes that must agree (direct, inverse, paraphrase, locate) plus a control
// with a known answer. Agreement far from 0.5 gives OK or VIOLATION; any split gives UNSURE,
// which goes to the Sonnet judge. Prints one JSON line per (file, rule). Needs AI_GATEWAY_API_KEY.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { experimental_evaluate as evaluate } from "ai";

const MODEL = "typesafe-ai/jev";
const SURE = 0.25;

const blockOf = (src, label) => {
  const at = src.indexOf(`label: "${label}"`);
  if (at < 0) return undefined;
  const start = src.lastIndexOf("operation(", at);
  let depth = 0;
  let end = start;
  for (let i = src.indexOf("(", start); i < src.length; i++) {
    if (src[i] === "(") depth++;
    if (src[i] === ")" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const first = src.slice(0, start).split("\n").length;
  const lines = src
    .slice(src.lastIndexOf("\n", start) + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .split("\n")
    .map((l, i) => [first + i, l.replace(/\s\/\/.*$/, "").replace(/^\s*\/\/.*$/, "")]);
  return { first, lines: lines.filter(([, l]) => l.trim()) };
};

const stateOf = (block) =>
  "One Tinker operation, with its file line numbers. `x.set(...)` writes a cell. " +
  "`x.of(key).get()` and `x.where(q).get()` read a cell. `depends` names each cell's " +
  "controller (members, issues, comments). `<check>.run(...)` runs the member check " +
  "issues.inTeam; a `viewer`/`me` dependency is the caller.\n\n" +
  block.lines.map(([n, l]) => `L${n} ${l}`).join("\n");

const lineChoice = (block, test, none) => {
  const picks = Object.fromEntries(
    block.lines.filter(([, l]) => test(l)).map(([n]) => [`L${n}`, `line L${n}`]),
  );
  return { ...picks, none };
};

const kindsOf = (block) =>
  [...new Set(block.lines.flatMap(([, l]) => [...l.matchAll(/kind:\s*"(\w+)"/g)].map((m) => m[1])))];

/** Each probe: `bad` is the answer that means a violation (true or a choice name test). */
const RULES = {
  J1: (block) =>
    kindsOf(block)
      .filter((k) => ["gone", "stale", "exists"].includes(k))
      .flatMap((k) => [
        { id: `${k}_direct`, bad: true, q: { type: "boolean", instructions: `Is a write present: on a path that ends in a return of kind "${k}", does any .set( run before that return?` } },
        { id: `${k}_inverse`, bad: false, q: { type: "boolean", instructions: `When this operation answers kind "${k}", is every cell exactly as it was before the call?` } },
        { id: `${k}_locate`, bad: (c) => c !== "none", q: { type: "choice", instructions: `On a path that ends in a return of kind "${k}", which line holds the first .set( call?`, criteria: lineChoice(block, (l) => l.includes(".set("), "no .set on that path") } },
      ]),
  J3: () => [
    { id: "direct", bad: true, q: { type: "boolean", instructions: "Can issues of another team change the number this operation gives the new issue?" } },
    { id: "inverse", bad: false, q: { type: "boolean", instructions: "Is the new issue's number computed only from issues whose teamId is the input's teamId?" } },
  ],
  J4: () => [
    { id: "direct", bad: true, q: { type: "boolean", instructions: "Is there an input version, other than the version stored now, that does NOT answer kind stale?" } },
    { id: "inverse", bad: false, q: { type: "boolean", instructions: "Does every input version that differs from the stored version answer kind stale?" } },
  ],
  J5: () => [
    { id: "direct", bad: true, q: { type: "boolean", instructions: "Can this operation find or act on an issue whose teamId differs from the input's teamId?" } },
    { id: "inverse", bad: false, q: { type: "boolean", instructions: "Is the issue looked up by a key that holds both the input's teamId and the issue id?" } },
  ],
  J6: (block) => [
    { id: "direct", bad: true, q: { type: "boolean", instructions: "Can a read of the issues cell run before the member check has returned true?" } },
    { id: "inverse", bad: false, q: { type: "boolean", instructions: "Does every read of the issues cell run only after the member check returned true?" } },
    { id: "paraphrase", bad: true, q: { type: "boolean", instructions: "For a caller who is not a member, does this operation read any issue?" } },
  ],
  J7: () => [
    { id: "direct", bad: true, q: { type: "boolean", instructions: "Can the caller's input choose the author of the new comment?" } },
    { id: "inverse", bad: false, q: { type: "boolean", instructions: "Is the new comment's author always the caller (the viewer), never a field of the input?" } },
  ],
  J2: () => [
    { id: "direct", bad: true, q: { type: "boolean", instructions: "Is there a part (members, issues or comments) whose read a non-member is NOT refused?" } },
    { id: "inverse", bad: false, q: { type: "boolean", instructions: "Does this hook refuse a non-member for every part it guards: members, issues and comments?" } },
  ],
};

const OPS = {
  J1: ["team.create.do", "team.add.do", "issue.create.do", "issue.move.do", "comment.add.do"],
  J2: ["issues.membersOnly"],
  J3: ["issue.create.do"],
  J4: ["issue.move.do"],
  J5: ["issue.move.do", "comment.add.do"],
  J6: ["issue.create.do", "issue.move.do", "comment.add.do"],
  J7: ["comment.add.do"],
};

/** The control: a fact the golden op always has, so a wrong answer marks the call as noise. */
const CONTROL = { type: "boolean", instructions: "Does this operation return a value with a `kind` field on at least one path?" };

const ask = async (state, questions) => {
  for (let i = 0; i < 5; i++) {
    try {
      return (await evaluate({ model: MODEL, state, questions })).answers;
    } catch (e) {
      if (!/rate|429/i.test(String(e?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 8000 * (i + 1)));
    }
  }
  throw new Error("jev: gave up after rate-limit retries");
};

const vote = (probe, answer) => {
  if (answer.type === "choice") {
    const bad = probe.bad(answer.choice);
    return { bad, sure: (answer.confidence ?? 0) >= 1 - SURE, line: bad ? answer.choice : undefined };
  }
  const p = answer.probability;
  return { bad: (p >= 0.5) === probe.bad, sure: p <= SURE || p >= 1 - SURE };
};

for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, "utf8");
  for (const [rule, labels] of Object.entries(OPS)) {
    const per = [];
    for (const label of labels) {
      const block = blockOf(src, label);
      if (!block) {
        per.push({ label, verdict: "UNSURE", why: "op not found" });
        continue;
      }
      const probes = RULES[rule](block);
      if (!probes.length) continue;
      const questions = { control: CONTROL, ...Object.fromEntries(probes.map((p) => [p.id, p.q])) };
      const answers = await ask(stateOf(block), questions);
      const votes = probes.map((p) => ({ id: p.id, ...vote(p, answers[p.id]) }));
      const control = answers.control.probability >= 1 - SURE;
      const groups = Object.groupBy(votes, (v) => (v.id.includes("_") ? v.id.split("_")[0] : "all"));
      const each = Object.values(groups).map((g) => {
        const bad = g.filter((v) => v.bad).length;
        if (!g.every((v) => v.sure) || (bad && bad < g.length)) return "UNSURE";
        return bad ? "VIOLATION" : "OK";
      });
      const verdict = !control
        ? "UNSURE"
        : each.includes("VIOLATION")
          ? "VIOLATION"
          : each.includes("UNSURE")
            ? "UNSURE"
            : "OK";
      const line = votes.find((v) => v.line)?.line;
      per.push({ label, verdict, at: line ? `${basename(file)}:${line.slice(1)}` : undefined, probes: Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.type === "choice" ? a.choice : Math.round(a.probability * 100) / 100])) });
    }
    const verdict = per.some((p) => p.verdict === "VIOLATION")
      ? "VIOLATION"
      : per.some((p) => p.verdict === "UNSURE")
        ? "UNSURE"
        : "OK";
    console.log(JSON.stringify({ app: basename(file, ".ts"), rule, verdict, ops: per }));
  }
}
