import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resource } from "@tinker/core";
import { z } from "zod";

import { severities } from "@/report";
import { appDir, reviewModel } from "@/tags";

import { loopConfig } from "./loop-config";
import { processes } from "./processes";
import { startRules } from "./start-rules";
import { type finding, store } from "./store";

/**
 * The prompt's first line. When a reviewer takes the prompt as one argv word, a word that starts
 * with `-` reads as an option, and the skill's front matter starts with `---`.
 */
export const promptTitle = "Review one change in this app with the tinker-review skill below.";

/** The rule of a reviewer line that is not a finding. */
export const outputRule = "review-output";

/**
 * The second model that reviews a change. With no loop.json `review.command`, it is Claude Code,
 * headless, with Read, Grep, and Glob only: `--restricted` removes every tool that runs commands
 * or code and ignores user, project, and local settings; `--tools` limits the tools that exist,
 * `--allowedTools` approves them, and `dontAsk` denies the rest. The prompt goes on stdin, or
 * into a `{prompt}` word when loop.json asks for one. It runs on the processes resource, which
 * owns the child; the prompt, stdout, and stderr are saved in `.loop/review/`.
 */
export const reviewer = resource({
  label: "loop.reviewer",
  depends: { appDir, processes, store, startRules, loopConfig, reviewModel },
  factory: (deps) => {
    const { appDir: app, processes: children, store: files, startRules: found } = deps;
    const { loopConfig: config, reviewModel: model } = deps;
    const ruleId = '"rule" must be a rule ID such as C3';
    const severity = `"severity" must be one of ${severities.join(", ")}`;
    const fileText = '"file" must name a file';
    const summaryText = '"summary" must say what is wrong';
    const lineNumber = '"line" must be a line number';
    const textFields = '"trigger" and "fix" must be text';

    /**
     * One finding line the reviewer prints, checked in this order; the first refusal names the
     * line. The reviewer does not report gates: G1 belongs to tinker-loop check.
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

    /** The review findings to recheck or keep, as the prompt shows them. */
    type Earlier = z.infer<typeof finding>[];

    const asker = {
      /** Make `.loop/review` and return its path. */
      folder: () => {
        const review = join(files.folder(), "review");
        mkdirSync(review, { recursive: true });
        return review;
      },

      /**
       * The rules the reviewer gets: the app's tinker-review skill, or else the review rules of
       * the app's own Start (`docs/rules.md`), with `from` naming that fallback. Throws when the
       * app has neither.
       */
      rules: () => {
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
      },

      /**
       * Write the change for the reviewer, who runs no commands: `change.patch`, the diff from
       * where the change starts to the work tree, and `untracked.txt`, the new files, one a line.
       */
      writeChange: (patch: string | null, untracked: string[]) => {
        writeFileSync(join(asker.folder(), "change.patch"), patch ?? "");
        writeFileSync(
          join(asker.folder(), "untracked.txt"),
          untracked.map((file) => `${file}\n`).join(""),
        );
      },

      /** Ask the reviewer about `prompt`. Resolves null when it ran, else how it ended. */
      ask: (prompt: string, signal?: AbortSignal) => {
        const promptFile = join(asker.folder(), "prompt.md");
        writeFileSync(promptFile, prompt);

        const words = config.review.command ?? [
          "claude",
          "-p",
          "--model",
          model,
          "--restricted",
          "--tools",
          "Read,Grep,Glob",
          "--allowedTools",
          "Read,Grep,Glob",
          "--permission-mode",
          "dontAsk",
          "--strict-mcp-config",
          "--no-session-persistence",
        ];
        const inline = words.includes("{prompt}");
        const command = inline ? words.map((word) => (word === "{prompt}" ? prompt : word)) : words;
        const job = {
          command,
          timeout: config.review.timeout,
          input: inline ? undefined : promptFile,
          out: join(asker.folder(), "output.txt"),
          err: join(asker.folder(), "stderr.log"),
        };
        return children.run(job, signal);
      },

      /** What the reviewer printed. */
      reply: () => readFileSync(join(asker.folder(), "output.txt"), "utf8"),

      /** How many lines a file's text has. */
      lineCount: (text: string) =>
        text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0),

      /**
       * A reported line past the end of its file gets line 0 and a note, so no fake location
       * is shown. A file the loop cannot read keeps its line.
       */
      place: (row: z.infer<typeof finding>) => {
        if (!row.line) return row;
        let text;
        try {
          text = readFileSync(join(app, row.file ?? ""), "utf8");
        } catch {
          return row;
        }

        const count = asker.lineCount(text);
        if (row.line <= count) return row;
        const note = `The reviewer gave line ${row.line}; the file has ${count} line${count === 1 ? "" : "s"}.`;
        return { ...row, line: 0, trigger: row.trigger ? `${row.trigger} (${note})` : note };
      },

      /**
       * The prompt: a plain title line, the skill, then this review's range, the open findings
       * to recheck, the answered findings, and the output it must print. The change is in files,
       * so the prompt stays small however large the change is. `untracked` is null outside git.
       */
      prompt: (review: {
        rules: string;
        range: { ref: string | null; start: string };
        head: string | null;
        untracked: string[] | null;
        open: Earlier;
        answered: Earlier;
      }) => {
        const { range, head, untracked, open, answered } = review;
        const recheck = open.length
          ? [
              "Read the code of each finding below at the work tree.",
              'If it is still there, print it again as a finding line with the same "id".',
              `If it is fixed, print only {"id": "<its id>", "status": "fixed"}.`,
              "",
              ...open.map((f) => {
                const { id, rule, severity: level, file, line, summary: text } = f;
                return JSON.stringify({ id, rule, severity: level, file, line, summary: text });
              }),
            ]
          : ["None: this is the first review, or all earlier findings are closed."];
        const kept = answered.length
          ? [
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
          : ["None."];

        return [
          promptTitle,
          "",
          review.rules.trimEnd(),
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
          untracked?.length
            ? `${untracked.length} new files not yet in git are listed in .loop/review/untracked.txt; read each one whole.`
            : "There are no new untracked files in the change.",
          "You can use Read, Grep, and Glob. You cannot run commands.",
          "Run the skill's quick scan with Grep on .loop/review/change.patch.",
          "Do not run the gates: tinker-loop check runs them. Skip the skill's gates step and do not report G1.",
          "",
          "## Open findings to recheck",
          "",
          ...recheck,
          "",
          "## Answered findings",
          "",
          ...kept,
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
      },

      /** A question row for a reviewer line that is not a finding, so nothing it said is lost. */
      badLine: (line: string, number: number, problem?: string) => {
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
      },

      /** The id a reviewer line names, if it names one. */
      idOf: (value: object) => ("id" in value && typeof value.id === "string" ? value.id : null),

      /** A checked reviewer finding as a review row. */
      reviewRow: (data: z.infer<typeof reviewerFinding>) => ({
        rule: data.rule,
        severity: data.severity,
        file: data.file,
        line: data.line ?? null,
        summary: data.summary,
        trigger: data.trigger ?? "",
        fix: data.fix ?? "",
        source: "review",
      }),

      /** A reviewer finding as a review row; a known id keeps its row, any other gets the loop's id. */
      rowOf: (value: object, known: string[]) => {
        const read = reviewerFinding.safeParse(value);
        if (!read.success) return { problem: read.error.issues[0]?.message ?? "" };
        const row = asker.reviewRow(read.data);
        const named = asker.idOf(value);
        return {
          row: { id: named && known.includes(named) ? named : files.findingId(row), ...row },
        };
      },

      /** A reviewer line as a JSON object, or why it is not one. */
      parseLine: (line: string) => {
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
      },

      /** One reviewer line: a fixed recheck, a finding row, or why it is not one. */
      readLine: (line: string, recheck: string[], known: string[]) => {
        const parsed = asker.parseLine(line);
        if ("problem" in parsed) return parsed;
        const { value } = parsed;
        if (!("status" in value) || value.status !== "fixed") return asker.rowOf(value, known);

        const id = asker.idOf(value) ?? "";
        return recheck.includes(id)
          ? { fixed: id }
          : { problem: "it marks a finding fixed that was not sent for recheck" };
      },

      /**
       * The reviewer's report: its findings as review rows, once per id, each placed in its
       * file, and the open ids it rechecked as fixed. Blank lines, code fences, and a `clear`
       * line are skipped. Only an open finding can be rechecked; an answered one keeps its id.
       */
      findings: (open: Earlier, answered: Earlier) => {
        const recheck = open.map((f) => f.id);
        const known = [...recheck, ...answered.map((f) => f.id)];
        const fixed: string[] = [];

        const rows = asker
          .reply()
          .split(/\r?\n/)
          .flatMap((raw, index) => {
            const line = raw.trim();
            if (!line || line.startsWith("```") || /^clear\b/i.test(line)) return [];

            const read = asker.readLine(line, recheck, known);
            if ("fixed" in read) {
              if (!fixed.includes(read.fixed)) fixed.push(read.fixed);
              return [];
            }
            if ("row" in read && read.row) return [read.row];
            return [asker.badLine(line, index + 1, read.problem)];
          });
        const reported = rows
          .filter((row, index) => rows.findIndex((other) => other.id === row.id) === index)
          .map((row) => asker.place(row));
        return { reported, fixed };
      },
    };

    return asker;
  },
});
