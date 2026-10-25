import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resource } from "@tinker/core";
import type { z } from "zod";

import { appDir, reviewModel } from "@/tags";

import { loopConfig } from "./loop-config";
import { processes } from "./processes";
import { startRules } from "./start-rules";
import { type finding, store } from "./store";

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
    /** How many lines a file's text has. */
    const lineCount = (text: string) =>
      text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    /** Make `.loop/review` and return its path. */
    const folder = () => {
      const review = join(files.folder(), "review");
      mkdirSync(review, { recursive: true });
      return review;
    };

    return {
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
        writeFileSync(join(folder(), "change.patch"), patch ?? "");
        writeFileSync(
          join(folder(), "untracked.txt"),
          untracked.map((file) => `${file}\n`).join(""),
        );
      },

      /** Ask the reviewer about `prompt`. Resolves null when it ran, else how it ended. */
      ask: (prompt: string, signal?: AbortSignal) => {
        const promptFile = join(folder(), "prompt.md");
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
          out: join(folder(), "output.txt"),
          err: join(folder(), "stderr.log"),
        };
        return children.run(job, signal);
      },

      /** What the reviewer printed. */
      reply: () => readFileSync(join(folder(), "output.txt"), "utf8"),

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

        const count = lineCount(text);
        if (row.line <= count) return row;
        const note = `The reviewer gave line ${row.line}; the file has ${count} line${count === 1 ? "" : "s"}.`;
        return { ...row, line: 0, trigger: row.trigger ? `${row.trigger} (${note})` : note };
      },
    };
  },
});
