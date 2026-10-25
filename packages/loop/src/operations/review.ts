import { operation } from "@tinker/core";
import { z } from "zod";

import { severities, summary } from "@/report";
import { git } from "@/resources/git";
import { reviewer } from "@/resources/reviewer";
import { scan } from "@/resources/scan";
import { type finding, store } from "@/resources/store";
import { baseRef, print, stop, warn } from "@/tags";

/**
 * The prompt's first line. When a reviewer takes the prompt as one argv word, a word that starts
 * with `-` reads as an option, and the skill's front matter starts with `---`.
 */
const promptTitle = "Review one change in this app with the tinker-review skill below.";

/** The rule of a reviewer line that is not a finding. */
const outputRule = "review-output";

const ruleId = '"rule" must be a rule ID such as C3';
const severity = `"severity" must be one of ${severities.join(", ")}`;
const fileText = '"file" must name a file';
const summaryText = '"summary" must say what is wrong';
const lineNumber = '"line" must be a line number';
const textFields = '"trigger" and "fix" must be text';

/**
 * One finding line the reviewer prints, checked in this order; the first refusal names the line.
 * The reviewer does not report gates: G1 belongs to tinker-loop check.
 */
const reviewerFinding = z.looseObject({
  rule: z
    .string({ error: ruleId })
    .regex(/^[A-Z][0-9]+$/, { error: ruleId })
    .refine((rule) => rule !== "G1", {
      error: '"G1" belongs to tinker-loop check; the reviewer does not report gates',
    }),
  severity: z.string({ error: severity }).refine((name) => severities.includes(name), {
    error: severity,
  }),
  file: z.string({ error: fileText }).refine((file) => file.trim() !== "", { error: fileText }),
  summary: z
    .string({ error: summaryText })
    .refine((text) => text.trim() !== "", { error: summaryText }),
  line: z
    .number({ error: lineNumber })
    .int({ error: lineNumber })
    .positive({ error: lineNumber })
    .nullable()
    .optional(),
  trigger: z.string({ error: textFields }).optional(),
  fix: z.string({ error: textFields }).optional(),
});

/**
 * `tinker-loop review [--base <ref>]`: a second model reviews the change, and its findings merge
 * as one review round. Findings are advice, so a review that ran is done; a reviewer that failed
 * or timed out writes nothing. The reviewer gets the app's tinker-review skill, or else its
 * Start's rules, the change as files (it runs no commands), and the open and answered review
 * findings to recheck.
 */
export const review = operation({
  label: "loop.review",
  depends: { baseRef, store, git, scan, reviewer, print, warn, stop },
  run: async (deps) => {
    const { baseRef: wanted, store: files, git: answers } = deps;
    const { scan: scanner, reviewer: asker, print: say, warn: complain } = deps;
    const signal = deps.stop;

    /** Where the change starts: the merge base of HEAD and the base, as check's scan finds it. */
    const reviewRange = () => {
      const ref = scanner.base();
      if (!ref && wanted) return null;
      const start = ref ? answers.run(["merge-base", ref, "HEAD"]) : null;
      if (!start) {
        throw new Error('no base found to review from; set "base" in loop.json or pass --base');
      }
      return { ref, start };
    };

    const rules = asker.rules();
    const range = reviewRange();
    if (!range) {
      complain(`tinker-loop review: git cannot find --base ${wanted}`);
      return "refused" as const;
    }

    // `.loop` ignores itself, so make it before the work tree is read.
    files.folder();
    const tree = answers.tree();
    const head = answers.headSha();
    const earlier = files.findings().filter((f) => f.source === "review" && f.rule !== outputRule);
    const open = earlier.filter((f) => f.status === "open");
    const answered = earlier.filter((f) => f.status === "answered");
    const recheck = new Set(open.map((f) => f.id));
    const known = new Set([...open, ...answered].map((f) => f.id));
    const untracked = tree.untracked ?? [];
    const patch = answers.run(
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--relative",
        range.start,
      ],
      { raw: true },
    );
    asker.writeChange(patch, untracked);
    if (rules.from) say(`review: no tinker-review skill in this app; using ${rules.from}`);
    say(`reviewed: ${answers.appScope()} only`);

    /** The open findings to recheck, as JSON lines. */
    const recheckLines = () =>
      open.length
        ? [
            "## Open findings to recheck",
            "",
            "Read the code of each finding below at the work tree.",
            'If it is still there, print it again as a finding line with the same "id".',
            `If it is fixed, print only {"id": "<its id>", "status": "fixed"}.`,
            "",
            ...open.map((f) => {
              const { id, rule, severity: level, file, line, summary: text } = f;
              return JSON.stringify({ id, rule, severity: level, file, line, summary: text });
            }),
          ]
        : [
            "## Open findings to recheck",
            "",
            "None: this is the first review, or all earlier findings are closed.",
          ];
    /** The answered findings, with their reason, as JSON lines. */
    const answeredLines = () =>
      answered.length
        ? [
            "## Answered findings",
            "",
            "The writer answered these with a reason. Do not report them as new findings.",
            'If you find the same problem again, print it as a finding line with the same "id".',
            "",
            ...answered.map((f) => {
              const { id, rule, severity: level, file, line, summary: text, reason } = f;
              return JSON.stringify({
                id,
                rule,
                severity: level,
                file,
                line,
                summary: text,
                reason,
              });
            }),
          ]
        : ["## Answered findings", "", "None."];
    /**
     * The prompt: a plain title line, the skill, then this review's range, the open findings to
     * recheck, the answered findings, and the output it must print. The change is in files, so
     * the prompt stays small however large the change is.
     */
    const promptText = () =>
      [
        promptTitle,
        "",
        rules.text.trimEnd(),
        "",
        "---",
        "",
        "# This review",
        "",
        "You run in the app folder. Do not edit files.",
        `The change starts at ${range.start}, where this branch left ${range.ref}.`,
        `It ends at the work tree, uncommitted edits included. HEAD is ${head ?? "not a commit"}.`,
        "Read the change in .loop/review/change.patch: the git diff from that commit to the work tree,",
        "for this app folder only. It replaces the skill's `git diff <base>..HEAD`.",
        untracked.length && tree.untracked
          ? `${untracked.length} new files not yet in git are listed in .loop/review/untracked.txt; read each one whole.`
          : "There are no new untracked files in the change.",
        "You can use Read, Grep, and Glob. You cannot run commands.",
        "Run the skill's quick scan with Grep on .loop/review/change.patch.",
        "Do not run the gates: tinker-loop check runs them. Skip the skill's gates step and do not report G1.",
        "",
        ...recheckLines(),
        "",
        ...answeredLines(),
        "",
        "## Output",
        "",
        "Print only JSON lines: one line for each finding, and the recheck lines above.",
        'A finding line has the fields "id", "rule", "severity", "file", "line", "summary", "trigger", and "fix".',
        '"line" is the line number in the file at the work tree, not a line in the patch.',
        "Do not report G1.",
        'For a new finding, "id" may be any short slug.',
        "Print no other text and no code fences. With no findings, print nothing.",
        "",
      ].join("\n");

    const ending = await asker.ask(promptText(), signal);
    if (signal.aborted) return "stopped" as const;
    if (ending) {
      complain(`tinker-loop review: the reviewer ${ending}; see .loop/review/stderr.log`);
      return "failed" as const;
    }

    /** A question row for a reviewer line that is not a finding, so nothing it said is lost. */
    const badLine = (line: string, number: number, problem?: string) => {
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
      return { id: files.findingId(row), ...row };
    };
    /** The id a reviewer line names, if it names one. */
    const idOf = (value: object) =>
      "id" in value && typeof value.id === "string" ? value.id : null;
    /** A checked reviewer finding as a review row. */
    const reviewRow = (data: z.infer<typeof reviewerFinding>) => ({
      rule: data.rule,
      severity: data.severity,
      file: data.file,
      line: data.line ?? null,
      summary: data.summary,
      trigger: data.trigger ?? "",
      fix: data.fix ?? "",
      source: "review",
    });
    /** A reviewer finding as a review row; a known id keeps its row, any other gets the loop's id. */
    const rowOf = (value: object) => {
      const read = reviewerFinding.safeParse(value);
      if (!read.success) return { problem: read.error.issues[0]?.message ?? "" };
      const row = reviewRow(read.data);
      const named = idOf(value);
      return { row: { id: named && known.has(named) ? named : files.findingId(row), ...row } };
    };
    /** A reviewer line as a JSON object, or why it is not one. */
    const parseLine = (line: string) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return { problem: "it is not JSON" };
      }

      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { problem: "it is not a JSON object" };
      }
      return { value };
    };
    /** One reviewer line: a fixed recheck, a finding row, or why it is not one. */
    const readLine = (line: string) => {
      const parsed = parseLine(line);
      if ("problem" in parsed) return parsed;
      const { value } = parsed;
      if (!("status" in value) || value.status !== "fixed") return rowOf(value);

      const id = idOf(value) ?? "";
      return recheck.has(id)
        ? { fixed: id }
        : { problem: "it marks a finding fixed that was not sent for recheck" };
    };

    /**
     * The reviewer's report: its findings as review rows, once per id, and the open ids it
     * rechecked as fixed. Blank lines, code fences, and a `clear` line are skipped; the reviewer
     * resource places each reported line in its file.
     */
    const fixed = new Set<z.infer<typeof finding>["id"]>();
    const lines = asker.reply().split(/\r?\n/);
    const rows = lines.flatMap((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith("```") || /^clear\b/i.test(line)) return [];

      const read = readLine(line);
      if ("fixed" in read) {
        fixed.add(read.fixed);
        return [];
      }
      if ("row" in read && read.row) return [read.row];
      return [badLine(line, index + 1, read.problem)];
    });
    const reported = rows
      .filter((row, index) => rows.findIndex((other) => other.id === row.id) === index)
      .map((row) => asker.place(row));

    let round = 0;
    const merge = () => {
      // A stop can land while another tool holds the lock; then this run records nothing.
      if (signal.aborted) return null;
      round = files.nextRound();
      files.appendRound({ round, source: "review", sha: head });
      const stamp = { round, sha: head, dirty: tree.dirty };

      const byId = new Map(reported.map((row) => [row.id, row]));
      const merged = files.findings().map((old) => {
        const now = byId.get(old.id);
        byId.delete(old.id);
        if (now) return files.seen(old, now, stamp);

        const rechecked = old.source === "review" && old.status === "open" && fixed.has(old.id);
        return rechecked ? files.fixed(old, stamp) : old;
      });
      const next = [...merged, ...[...byId.values()].map((row) => files.opened(row, stamp))];
      files.writeFindings(next);
      return next;
    };
    // A stop while another tool holds the lock ends the wait: then this run is stopped.
    const merged = await files.locked(merge, signal).catch((error: unknown) => {
      if (signal.aborted) return null;
      throw error;
    });
    if (!merged) return "stopped" as const;

    say(
      `tinker-loop review, round ${round}: ${reported.length} reported, ${fixed.size} rechecked fixed`,
    );
    for (const line of summary(merged)) say(line);
    return "done" as const;
  },
});
