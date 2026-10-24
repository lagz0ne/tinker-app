import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resource } from "@tinker/core";

import { appDir } from "@/tags";

import { git } from "./git";
import { store } from "./store";

/**
 * The tinker-review quick-scan greps, one rule each. A hit points at a line to read; it is
 * not a verdict. randomUUID is B3 (the unit's random); setInterval is O1 (an owned timer).
 */
const scans = [
  {
    rule: "B1",
    pattern: /process\.(env|argv|exit)/,
    topic: "process global",
    fix: "Only cmds/* reads process inputs; bind a typed tag instead.",
  },
  {
    rule: "B3",
    pattern: /Date\.now|Math\.random/,
    topic: "clock or random",
    fix: "Use the unit's clock and random.",
  },
  { rule: "B3", pattern: /randomUUID/, topic: "random id", fix: "Use the unit's random." },
  {
    rule: "O1",
    pattern: /setInterval/,
    topic: "timer",
    fix: "Give the timer an owner that releases it with defer.",
  },
  {
    rule: "O1",
    pattern: /\bclass [A-Z]/,
    topic: "class",
    fix: "Declare a tag, data, resource, or operation instead of a class.",
  },
  {
    rule: "H3",
    pattern: /\bfetch\(|node:(net|http)/,
    topic: "raw HTTP or socket",
    fix: "Send outgoing HTTP through httpRequest.controller.",
  },
  { rule: "H5", pattern: /\.skip\(/, topic: "skipped test", fix: "Run the test or delete it." },
  {
    rule: "H2",
    pattern: / as unknown as /,
    topic: "double cast",
    fix: "Check the input and use the checked result.",
  },
];

/**
 * The change check scans: where it starts, its diff, and the quick-scan hits on its added
 * lines. Scan findings are questions that point at a line to read.
 */
export const scan = resource({
  label: "loop.scan",
  depends: { appDir, git, store },
  factory: ({ appDir: app, git: answers, store: files }) => {
    /** An untracked file as a diff that adds every line; links, binary, large, gone files add nothing. */
    const addedFile = (file: string) => {
      let text;
      try {
        const stat = lstatSync(join(app, file));
        if (!stat.isFile() || stat.size > 1024 * 1024) return "";
        text = readFileSync(join(app, file), "utf8");
      } catch {
        return "";
      }

      if (text.includes("\0")) return "";
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      return [`diff --git a/${file} b/${file}`, `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`]
        .concat(lines.map((line) => `+${line}`))
        .join("\n");
    };

    /**
     * Each added line with its file and new line number. A file is undefined while its header
     * is read, so only a header's `+++` line names it; an added `++` line never does. Git ends a
     * path that has a space with a tab, which is not part of the name.
     */
    const addedLines = (diff: string) => {
      const added: { file: string; line: number; text: string }[] = [];
      let file: string | null | undefined;
      let line = 0;
      const pathOf = (text: string) =>
        text.startsWith("+++ b/") ? text.slice(6).replace(/\t$/, "") : null;
      const hunkStart = (text: string) => Number(/\+(\d+)/.exec(text)?.[1]);
      const read = (text: string) => {
        if (text.startsWith("diff --git ")) file = undefined;
        else if (file === undefined && text.startsWith("+++ ")) file = pathOf(text);
        else if (text.startsWith("@@ ")) line = hunkStart(text);
        else if (file && text.startsWith("+")) {
          added.push({ file, line, text: text.slice(1) });
          line += 1;
        }
      };

      for (const text of diff.split("\n")) read(text);
      return added;
    };
    /** `<remote>/<branch>` when the repo has exactly one remote, and it has the branch. */
    const remoteBranch = (branch: string) => {
      const remotes = (answers.run(["remote"]) ?? "").split("\n").filter(Boolean);
      const ref = remotes.length === 1 ? `${remotes[0]}/${branch}` : null;
      return ref && answers.commitSha(ref) ? ref : null;
    };

    /** The quick-scan findings on one added line. */
    const lineHits = ({ file, line, text }: { file: string; line: number; text: string }) => {
      const code = text.trim();
      const shown = code.length > 120 ? `${code.slice(0, 117)}...` : code;
      return scans
        .filter((rule) => rule.pattern.test(code))
        .map((rule) => {
          const hit = {
            rule: rule.rule,
            severity: "question",
            file,
            line,
            summary: `${rule.topic}: ${shown}`,
            trigger:
              "Quick-scan grep hit on an added line. Read the code before you call it a problem.",
            fix: rule.fix,
            source: "check",
          };
          return { id: files.findingId(hit), ...hit };
        });
    };

    return {
      /**
       * The ref the scan starts from, or null when git cannot find one. `wanted` (--base) stays
       * exact. A loop.json branch that tracks a remote resolves to that remote branch, since a
       * local copy is often old; next comes the branch itself, then `<remote>/<branch>` when the
       * repo has one remote.
       */
      base: ({ wanted, configured }: { wanted: string | null; configured: string | null }) => {
        if (wanted) return answers.commitSha(wanted) ? wanted : null;
        if (!configured) return null;

        const upstream = answers.run([
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          `${configured}@{upstream}`,
        ]);
        if (upstream) return upstream;
        return answers.commitSha(configured) ? configured : remoteBranch(configured);
      },

      /**
       * The change as a diff, scoped to the app folder, with app-relative paths. It starts where
       * the branch left `base`, so a base that moved on adds no other commits; it ends at the
       * work tree, and the untracked files from before the gates are all added. Null when the
       * folder is not in git or git cannot diff.
       */
      diff: (base: string, untracked: string[] | null) => {
        const start = answers.run(["merge-base", base, "HEAD"]);
        if (!start || !untracked) return null;

        const tracked = answers.run([
          "-c",
          "core.quotePath=false",
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "-U0",
          "--relative",
          start,
        ]);
        if (tracked === null) return null;
        return [tracked, ...untracked.map(addedFile)].join("\n");
      },

      /** Quick-scan hits on the added lines of a unified diff, once per finding id. */
      hits: (diff: string) => {
        const found = new Map<string, ReturnType<typeof lineHits>[number]>();
        for (const hit of addedLines(diff).flatMap(lineHits)) {
          if (!found.has(hit.id)) found.set(hit.id, hit);
        }
        return [...found.values()];
      },
    };
  },
});
