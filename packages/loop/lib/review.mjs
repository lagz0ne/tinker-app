import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  findingId,
  loopFolder,
  mergeReview,
  readFindings,
  recordReviewRound,
  severities,
  updateFindings,
} from "./findings.mjs";
import { git, headSha } from "./git.mjs";
import { runProcess } from "./process.mjs";
import { summary } from "./report.mjs";
import { scanBase, treeState } from "./scan.mjs";

/** The reviewer model Duke picked. */
export const reviewModel = "claude-opus-5-5";

/**
 * The reviewer command when loop.json has no `review.command`: Claude Code, headless, with
 * read-only tools. `--tools` limits the tools that exist, `--allowedTools` approves them with
 * Bash held to git diff, log, and show, and `dontAsk` denies the rest. `{prompt}` is replaced
 * by the prompt; it sits before the tool lists, which take every word after them.
 */
export const defaultReviewCommand = [
  "claude",
  "-p",
  "{prompt}",
  "--model",
  reviewModel,
  "--tools",
  "Read,Grep,Glob,Bash",
  "--allowedTools",
  "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*)",
  "--permission-mode",
  "dontAsk",
  "--strict-mcp-config",
  "--no-session-persistence",
];

/** The rule of a question row made from a reviewer line that is not a finding. */
export const outputRule = "review-output";

/**
 * Run the reviewer on the change, then merge its findings as one review round. Returns the
 * exit code: 0 when the review ran, since findings are advice; 1 when the reviewer failed or
 * timed out, with nothing written; 64 for an unknown --base. Throws (exit 78) when the skill,
 * loop.json, or a base is missing.
 * @param {string} app - From --app; why: the app to review.
 * @param {{ base?: string, config: { base: string | null, review: { command?: string[],
 *   timeout?: number } }, print: (line: string) => void,
 *   stderr: { write(chunk: string): unknown }, signal?: AbortSignal }} run - From main; why:
 *   the range, the reviewer command, where to print, and the stop.
 */
export async function runReview(app, { base, config, print, stderr, signal }) {
  const skill = join(app, ".agents", "skills", "tinker-review", "SKILL.md");
  if (!existsSync(skill)) {
    throw new Error(`${skill} is missing; review needs the app's tinker-review skill`);
  }
  const range = reviewRange(app, base, config.base);
  if (!range) {
    stderr.write(`tinker-loop review: git cannot find --base ${base}\n`);
    return 64;
  }

  const tree = treeState(app);
  const head = headSha(app);
  const open = readFindings(app).filter((f) => f.source === "review" && f.status === "open");
  const prompt = reviewPrompt({ skill: readFileSync(skill, "utf8"), ...range, head, tree, open });
  const ending = await askReviewer(app, { review: config.review, prompt, signal });
  if (signal?.aborted) return 130;
  if (ending) {
    stderr.write(`tinker-loop review: the reviewer ${ending}; see .loop/review/stderr.log\n`);
    return 1;
  }

  const output = readFileSync(join(app, ".loop", "review", "output.txt"), "utf8");
  const reported = parseReview(output, new Set(open.map((f) => f.id)));
  const round = recordReviewRound(app, { sha: head });
  const merged = updateFindings(app, (previous) =>
    mergeReview(previous, reported, { round, sha: head, dirty: tree.dirty }),
  );
  print(
    `tinker-loop review, round ${round}: ${reported.found.length} reported, ${reported.fixed.size} rechecked fixed`,
  );
  for (const line of summary(merged)) print(line);
  return 0;
}

/**
 * Where the change starts: the merge base of HEAD and the base, as check's scan uses.
 * Returns null for an unknown --base. Throws when there is no base to use at all.
 * @param {string} app - From runReview; why: the repo to ask.
 * @param {string | undefined} base - From --base; why: the exact ref asked for.
 * @param {string | null} configured - From loop.json; why: the base branch otherwise.
 */
function reviewRange(app, base, configured) {
  const ref = scanBase(app, { base, config: configured });
  if (!ref && base) return null;

  const start = ref ? git(app, ["merge-base", ref, "HEAD"]) : null;
  if (!start) {
    throw new Error('no base found to review from; set "base" in loop.json or pass --base');
  }
  return { ref, start };
}

/**
 * Run the reviewer command with the prompt, no stdin, and the gates' process-group timeout.
 * The prompt, stdout, and stderr are saved in `.loop/review/`. Resolves null when it ran.
 * @param {string} app - From runReview; why: the reviewer runs in the app folder.
 * @param {{ review: { command?: string[], timeout?: number }, prompt: string,
 *   signal?: AbortSignal }} ask - From runReview; why: the command, the prompt, and the stop.
 */
async function askReviewer(app, { review, prompt, signal }) {
  const folder = join(loopFolder(app), "review");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "prompt.md"), prompt);

  const command = reviewArgv(review.command ?? defaultReviewCommand, prompt);
  const out = join(folder, "output.txt");
  const err = join(folder, "stderr.log");
  return runProcess(app, { command, timeout: review.timeout, out, err }, signal);
}

/**
 * The reviewer's argv: each `{prompt}` word becomes the prompt; with none, the prompt is the
 * last word.
 * @param {string[]} command - From loop.json or defaultReviewCommand; why: the program and
 *   its arguments.
 * @param {string} prompt - From reviewPrompt; why: what the reviewer reads.
 */
export function reviewArgv(command, prompt) {
  return command.includes("{prompt}")
    ? command.map((word) => (word === "{prompt}" ? prompt : word))
    : [...command, prompt];
}

/**
 * The reviewer's prompt: the skill, then this review's range, the open findings to recheck,
 * and the output it must print.
 * @param {{ skill: string, ref: string, start: string, head: string | null,
 *   tree: { untracked: string[] | null }, open: object[] }} review - From runReview; why: the
 *   rules, the change, and the findings still open from earlier rounds.
 */
export function reviewPrompt({ skill, ref, start, head, tree, open }) {
  const untracked = tree.untracked?.length
    ? [
        "New files in the change, not yet in git; read each one whole:",
        ...tree.untracked.map((f) => `- ${f}`),
      ]
    : ["There are no new untracked files in the change."];
  const recheck = open.length
    ? [
        "## Open findings to recheck",
        "",
        "Read the code of each finding below at the work tree.",
        'If it is still there, print it again as a finding line with the same "id".',
        `If it is fixed, print only {"id": "<its id>", "status": "fixed"}.`,
        "",
        ...open.map((f) =>
          JSON.stringify({
            id: f.id,
            rule: f.rule,
            severity: f.severity,
            file: f.file,
            line: f.line,
            summary: f.summary,
          }),
        ),
      ]
    : [
        "## Open findings to recheck",
        "",
        "None: this is the first review, or all earlier findings are closed.",
      ];

  return [
    skill.trimEnd(),
    "",
    "---",
    "",
    "# This review",
    "",
    "You run in the app folder. Do not edit files.",
    `The change starts at ${start}, where this branch left ${ref}.`,
    `It ends at the work tree, uncommitted edits included. HEAD is ${head ?? "not a commit"}.`,
    `See it with \`git diff ${start} -- .\`; this replaces the skill's \`git diff <base>..HEAD\`.`,
    ...untracked,
    "You can use Read, Grep, Glob, and git diff, git log, and git show.",
    "Do not run the gates: tinker-loop check runs them. Skip the skill's gates step and do not report G1.",
    "",
    ...recheck,
    "",
    "## Output",
    "",
    "Print only JSON lines: one line for each finding, in the skill's Report shape, and the recheck lines above.",
    'For a new finding, "id" may be any short slug.',
    "Print no other text and no code fences. With no findings, print nothing.",
    "",
  ].join("\n");
}

/**
 * The reviewer's report: its findings as review rows, and the open ids it rechecked as fixed.
 * Blank lines, code fences, and a `clear` line are skipped. Any other line that is not a
 * finding becomes one question row that names it, so nothing the reviewer said is lost.
 * A reported id from the recheck list keeps that id; any other finding gets the loop's id.
 * @param {string} text - From the reviewer's stdout; why: the report to read.
 * @param {Set<string>} openIds - From runReview; why: the ids sent for recheck.
 */
export function parseReview(text, openIds) {
  const found = new Map();
  const fixed = new Set();

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("```") || /^clear\b/i.test(line)) return;

    const read = readReviewLine(line, openIds);
    if (read.fixed) fixed.add(read.fixed);
    else {
      const row = read.row ?? badLine(line, index + 1, read.problem);
      if (!found.has(row.id)) found.set(row.id, row);
    }
  });
  return { found: [...found.values()], fixed };
}

/**
 * @param {string} line - From parseReview; why: one line of the report.
 * @param {Set<string>} openIds - From parseReview; why: only these may be marked fixed.
 */
function readReviewLine(line, openIds) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return { problem: "it is not JSON" };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { problem: "it is not a JSON object" };
  }
  if (value.status === "fixed") {
    return openIds.has(value.id)
      ? { fixed: value.id }
      : { problem: "it marks a finding fixed that was not sent for recheck" };
  }
  const problem = findingProblem(value);
  return problem ? { problem } : { row: reviewRow(value, openIds) };
}

/** @param {Record<string, unknown>} value - From readReviewLine; why: the fields to check. */
function findingProblem(value) {
  const text = (field) => typeof value[field] === "string" && value[field].trim() !== "";
  const optional = (field) => value[field] === undefined || typeof value[field] === "string";
  const line = value.line ?? null;
  const checks = [
    [
      typeof value.rule === "string" && /^[A-Z][0-9]+$/.test(value.rule),
      '"rule" must be a rule ID such as C3',
    ],
    [severities.includes(value.severity), `"severity" must be one of ${severities.join(", ")}`],
    [text("file"), '"file" must name a file'],
    [text("summary"), '"summary" must say what is wrong'],
    [line === null || (Number.isSafeInteger(line) && line > 0), '"line" must be a line number'],
    [optional("trigger") && optional("fix"), '"trigger" and "fix" must be text'],
  ];
  return checks.find(([ok]) => !ok)?.[1] ?? null;
}

/**
 * @param {Record<string, any>} value - From readReviewLine; why: a checked finding.
 * @param {Set<string>} openIds - From readReviewLine; why: a rechecked id keeps its row.
 */
function reviewRow(value, openIds) {
  const row = {
    rule: value.rule,
    severity: value.severity,
    file: value.file,
    line: value.line ?? null,
    summary: value.summary,
    trigger: value.trigger ?? "",
    fix: value.fix ?? "",
    source: "review",
  };
  return { id: openIds.has(value.id) ? value.id : findingId(row), ...row };
}

/**
 * A question row for a reviewer line that is not a finding.
 * @param {string} line - From parseReview; why: the text to show.
 * @param {number} number - From parseReview; why: where it is in the saved output.
 * @param {string} problem - From readReviewLine; why: why it is not a finding.
 */
function badLine(line, number, problem) {
  const shown = line.length > 120 ? `${line.slice(0, 117)}...` : line;
  const row = {
    rule: outputRule,
    severity: "question",
    file: ".loop/review/output.txt",
    line: number,
    summary: `the reviewer printed a line that is not a finding: ${shown}`,
    trigger: `Line ${number} of the reviewer's output: ${problem}.`,
    fix: "Read the line; if it holds a finding, add it by hand or run review again.",
    source: "review",
  };
  return { id: findingId(row), ...row };
}
