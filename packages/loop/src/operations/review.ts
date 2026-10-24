import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { operation } from "@tinker/core";
import type { z } from "zod";

import { severities, summary } from "@/report";
import { git } from "@/resources/git";
import { reviewer } from "@/resources/reviewer";
import { scan } from "@/resources/scan";
import { startRules } from "@/resources/start-rules";
import { type finding, store } from "@/resources/store";
import { appDir, baseRef, loopConfig, print, stop, warn } from "@/tags";

/**
 * The prompt's first line. When a reviewer takes the prompt as one argv word, a word that starts
 * with `-` reads as an option, and the skill's front matter starts with `---`.
 */
const promptTitle = "Review one change in this app with the tinker-review skill below.";

/** The rule of a reviewer line that is not a finding. */
const outputRule = "review-output";

/**
 * `tinker-loop review [--base <ref>]`: a second model reviews the change, and its findings merge
 * as one review round. Findings are advice, so a review that ran is done; a reviewer that failed
 * or timed out writes nothing. The reviewer gets the app's tinker-review skill, or else its
 * Start's rules, the change as files (it runs no commands), and the open and answered review
 * findings to recheck.
 */
export const review = operation({
  label: "loop.review",
  depends: {
    appDir,
    loopConfig,
    baseRef,
    store,
    git,
    scan,
    reviewer,
    startRules,
    print,
    warn,
    stop,
  },
  run: async (deps) => {
    const { appDir: app, loopConfig: config, baseRef: wanted, store: files, git: answers } = deps;
    const { scan: scanner, reviewer: asker, startRules: found, print: say, warn: complain } = deps;
    const signal = deps.stop;
    type Row = z.infer<typeof finding>;

    /** The app's tinker-review skill, or else its Start's review rules, with `from` naming them. */
    const reviewRules = () => {
      const skill = join(app, ".agents", "skills", "tinker-review", "SKILL.md");
      if (existsSync(skill)) return { text: readFileSync(skill, "utf8"), from: null };

      let book;
      try {
        book = found.read();
      } catch (error) {
        throw new Error(
          `${skill} is missing, and the Start rules cannot be read (${(error as Error).message}); review needs one of them`,
        );
      }
      const text = [
        "# Review a change",
        "",
        "This app has no tinker-review skill, so these are the review rules of its Start.",
        "Each finding names one rule ID from the list below.",
        "",
        readFileSync(book.path, "utf8").trimEnd(),
      ].join("\n");
      return { text, from: `@tinker/start ${book.version} docs/rules.md` };
    };

    /** Where the change starts: the merge base of HEAD and the base, as check's scan finds it. */
    const reviewRange = () => {
      const ref = scanner.base({ wanted, configured: config.base });
      if (!ref && wanted) return null;
      const start = ref ? answers.run(["merge-base", ref, "HEAD"]) : null;
      if (!start) {
        throw new Error('no base found to review from; set "base" in loop.json or pass --base');
      }
      return { ref, start };
    };

    /** The change as files: the diff from `start` to the work tree, and the new untracked files. */
    const writeChange = (folder: string, start: string, untracked: string[]) => {
      const patch = answers.run(
        ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--relative", start],
        { raw: true },
      );
      writeFileSync(join(folder, "change.patch"), patch ?? "");
      writeFileSync(join(folder, "untracked.txt"), untracked.map((file) => `${file}\n`).join(""));
    };

    /** The earlier review findings as JSON lines, with `reason` for answered ones. */
    const earlierLines = (rows: Row[], reason: boolean) =>
      rows.map((f) =>
        JSON.stringify({
          id: f.id,
          rule: f.rule,
          severity: f.severity,
          file: f.file,
          line: f.line,
          summary: f.summary,
          ...(reason ? { reason: f.reason } : {}),
        }),
      );

    /**
     * The prompt: a plain title line, the skill, then this review's range, the open findings to
     * recheck, the answered findings, and the output it must print. The change is in files, so
     * the prompt stays small however large the change is.
     */
    const reviewPrompt = (p: {
      skill: string;
      ref: string | null;
      start: string;
      head: string | null;
      untracked: string[] | null;
      open: Row[];
      answered: Row[];
    }) => {
      const count = p.untracked?.length ?? 0;
      const untracked = count
        ? `${count} new files not yet in git are listed in .loop/review/untracked.txt; read each one whole.`
        : "There are no new untracked files in the change.";
      const known = p.answered.length
        ? [
            "## Answered findings",
            "",
            "The writer answered these with a reason. Do not report them as new findings.",
            'If you find the same problem again, print it as a finding line with the same "id".',
            "",
            ...earlierLines(p.answered, true),
          ]
        : ["## Answered findings", "", "None."];
      const recheck = p.open.length
        ? [
            "## Open findings to recheck",
            "",
            "Read the code of each finding below at the work tree.",
            'If it is still there, print it again as a finding line with the same "id".',
            `If it is fixed, print only {"id": "<its id>", "status": "fixed"}.`,
            "",
            ...earlierLines(p.open, false),
          ]
        : [
            "## Open findings to recheck",
            "",
            "None: this is the first review, or all earlier findings are closed.",
          ];

      return [
        promptTitle,
        "",
        p.skill.trimEnd(),
        "",
        "---",
        "",
        "# This review",
        "",
        "You run in the app folder. Do not edit files.",
        `The change starts at ${p.start}, where this branch left ${p.ref}.`,
        `It ends at the work tree, uncommitted edits included. HEAD is ${p.head ?? "not a commit"}.`,
        "Read the change in .loop/review/change.patch: the git diff from that commit to the work tree,",
        "for this app folder only. It replaces the skill's `git diff <base>..HEAD`.",
        untracked,
        "You can use Read, Grep, and Glob. You cannot run commands.",
        "Run the skill's quick scan with Grep on .loop/review/change.patch.",
        "Do not run the gates: tinker-loop check runs them. Skip the skill's gates step and do not report G1.",
        "",
        ...recheck,
        "",
        ...known,
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
    };

    /** Why a reviewer finding line does not fit, or null. */
    const findingProblem = (value: Record<string, unknown>) => {
      const text = (field: string) =>
        typeof value[field] === "string" && (value[field] as string).trim() !== "";
      const optional = (field: string) =>
        value[field] === undefined || typeof value[field] === "string";
      const line = value.line ?? null;
      const checks: [boolean, string][] = [
        [
          typeof value.rule === "string" && /^[A-Z][0-9]+$/.test(value.rule),
          '"rule" must be a rule ID such as C3',
        ],
        [
          value.rule !== "G1",
          '"G1" belongs to tinker-loop check; the reviewer does not report gates',
        ],
        [
          severities.includes(value.severity as string),
          `"severity" must be one of ${severities.join(", ")}`,
        ],
        [text("file"), '"file" must name a file'],
        [text("summary"), '"summary" must say what is wrong'],
        [
          line === null || (Number.isSafeInteger(line) && (line as number) > 0),
          '"line" must be a line number',
        ],
        [optional("trigger") && optional("fix"), '"trigger" and "fix" must be text'],
      ];
      return checks.find(([ok]) => !ok)?.[1] ?? null;
    };

    /** A reviewer finding as a review row; a known id keeps its row, any other gets the loop's id. */
    const reviewRow = (value: Record<string, unknown>, known: Set<string>) => {
      const row = {
        rule: String(value.rule),
        severity: String(value.severity),
        file: String(value.file),
        line: (value.line as number | undefined) ?? null,
        summary: String(value.summary),
        trigger: (value.trigger as string | undefined) ?? "",
        fix: (value.fix as string | undefined) ?? "",
        source: "review",
      };
      const id =
        typeof value.id === "string" && known.has(value.id) ? value.id : files.findingId(row);
      return { id, ...row };
    };

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

    /** A `{"id", "status": "fixed"}` line: only an id sent for recheck may be marked fixed. */
    const recheckLine = (fields: Record<string, unknown>, recheck: Set<string>) =>
      typeof fields.id === "string" && recheck.has(fields.id)
        ? { fixed: fields.id }
        : { problem: "it marks a finding fixed that was not sent for recheck" };

    /** One reviewer line read: a fixed recheck, a finding row, or why it is not one. */
    const readReviewLine = (line: string, ids: { recheck: Set<string>; known: Set<string> }) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return { problem: "it is not JSON" };
      }

      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { problem: "it is not a JSON object" };
      }
      const fields = value as Record<string, unknown>;
      if (fields.status === "fixed") return recheckLine(fields, ids.recheck);
      const problem = findingProblem(fields);
      return problem ? { problem } : { row: reviewRow(fields, ids.known) };
    };

    /**
     * The reviewer's report: its findings as review rows, and the open ids it rechecked as
     * fixed. Blank lines, code fences, and a `clear` line are skipped.
     */
    const parseReview = (text: string, ids: { recheck: Set<string>; known: Set<string> }) => {
      const rows = new Map<string, Row>();
      const fixed = new Set<string>();
      text.split(/\r?\n/).forEach((raw, index) => {
        const line = raw.trim();
        if (!line || line.startsWith("```") || /^clear\b/i.test(line)) return;

        const read = readReviewLine(line, ids);
        if ("fixed" in read && read.fixed) return void fixed.add(read.fixed);
        const row = "row" in read ? read.row : badLine(line, index + 1, read.problem);
        if (!rows.has(row.id)) rows.set(row.id, row);
      });
      return { found: [...rows.values()], fixed };
    };

    /** How many lines a file's text has. */
    const lineCount = (text: string) =>
      text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

    /** A line past the end of its file becomes line 0 with a note; an unreadable file keeps it. */
    const placeLine = (row: Row) => {
      if (!row.line) return row;
      let text;
      try {
        text = readFileSync(join(app, row.file ?? ""), "utf8");
      } catch {
        return row;
      }

      const count = lineCount(text);
      if (row.line <= count) return row;
      const note = `The reviewer gave line ${row.line}; the file has ${count} line${count === 1 ? "" : "s"}.`;
      return { ...row, line: 0, trigger: row.trigger ? `${row.trigger} (${note})` : note };
    };

    const rules = reviewRules();
    const range = reviewRange();
    if (!range) {
      complain(`tinker-loop review: git cannot find --base ${wanted}`);
      return "refused" as const;
    }

    const folder = join(files.folder(), "review");
    mkdirSync(folder, { recursive: true });
    const tree = answers.tree();
    const head = answers.headSha();
    const earlier = files.findings().filter((f) => f.source === "review" && f.rule !== outputRule);
    const open = earlier.filter((f) => f.status === "open");
    const answered = earlier.filter((f) => f.status === "answered");
    writeChange(folder, range.start, tree.untracked ?? []);
    if (rules.from) say(`review: no tinker-review skill in this app; using ${rules.from}`);
    say(`reviewed: ${answers.appScope()} only`);

    const prompt = reviewPrompt({
      skill: rules.text,
      ...range,
      head,
      untracked: tree.untracked,
      open,
      answered,
    });
    const ending = await asker.ask(prompt, signal);
    if (signal.aborted) return "stopped" as const;
    if (ending) {
      complain(`tinker-loop review: the reviewer ${ending}; see .loop/review/stderr.log`);
      return "failed" as const;
    }

    const output = readFileSync(join(folder, "output.txt"), "utf8");
    const parsed = parseReview(output, {
      recheck: new Set(open.map((f) => f.id)),
      known: new Set([...open, ...answered].map((f) => f.id)),
    });
    const reported = parsed.found.map(placeLine);
    const round = await files.recordReviewRound(head);
    const stamp = { round, sha: head, dirty: tree.dirty };
    const merge = () => {
      const byId = new Map(reported.map((row) => [row.id, row]));
      const merged = files.findings().map((old) => {
        const now = byId.get(old.id);
        byId.delete(old.id);
        if (now) return files.seen(old, now, stamp);

        const rechecked =
          old.source === "review" && old.status === "open" && parsed.fixed.has(old.id);
        return rechecked ? files.fixed(old, stamp) : old;
      });
      const next = [...merged, ...[...byId.values()].map((row) => files.opened(row, stamp))];
      files.writeFindings(next);
      return next;
    };
    const merged = await files.locked(merge);

    say(
      `tinker-loop review, round ${round}: ${reported.length} reported, ${parsed.fixed.size} rechecked fixed`,
    );
    for (const line of summary(merged)) say(line);
    return "done" as const;
  },
});
