import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resource } from "@tinker/core";

import { loopConfig, reviewModel } from "@/tags";

import { processes } from "./processes";
import { store } from "./store";

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
  depends: { processes, store, loopConfig, reviewModel },
  factory: ({ processes: children, store: files, loopConfig: config, reviewModel: model }) => ({
    /** Ask the reviewer about `prompt`. Resolves null when it ran, else how it ended. */
    ask: (prompt: string, signal?: AbortSignal) => {
      const folder = join(files.folder(), "review");
      mkdirSync(folder, { recursive: true });
      const promptFile = join(folder, "prompt.md");
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
        out: join(folder, "output.txt"),
        err: join(folder, "stderr.log"),
      };
      return children.run(job, signal);
    },
  }),
});
