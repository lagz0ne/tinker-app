import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resource } from "@tinker/core";

import { appDir, baseRef } from "@/tags";

import { git } from "./git";
import { loopConfig } from "./loop-config";
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
  depends: { appDir, baseRef, loopConfig, git, store },
  factory: ({ appDir: app, baseRef: wanted, loopConfig: config, git: answers, store: files }) => {
    const scanner = {
      /** An untracked file as a diff that adds every line; links, binary, large, gone files add nothing. */
      addedFile: (file: string) => {
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
      },

      /** The file a `+++` header line names; null for `/dev/null`. Git ends a path that has a space with a tab. */
      pathOf: (text: string) =>
        text.startsWith("+++ b/") ? text.slice(6).replace(/\t$/, "") : null,

      /** The first new line number a `@@` hunk header names. */
      hunkStart: (text: string) => Number(/\+(\d+)/.exec(text)?.[1]),

      /**
       * Each added line with its file and new line number. A file is undefined while its header
       * is read, so only a header's `+++` line names it; an added `++` line never does.
       */
      addedLines: (diff: string) => {
        const added: { file: string; line: number; text: string }[] = [];
        let file: string | null | undefined;
        let line = 0;
        for (const text of diff.split("\n")) {
          if (text.startsWith("diff --git ")) file = undefined;
          else if (file === undefined && text.startsWith("+++ ")) file = scanner.pathOf(text);
          else if (text.startsWith("@@ ")) line = scanner.hunkStart(text);
          else if (file && text.startsWith("+")) {
            added.push({ file, line: line++, text: text.slice(1) });
          }
        }
        return added;
      },

      /** `<remote>/<branch>` when the repo has exactly one remote, and it has the branch. */
      remoteBranch: (branch: string) => {
        const remotes = (answers.run(["remote"]) ?? "").split("\n").filter(Boolean);
        const ref = remotes.length === 1 ? `${remotes[0]}/${branch}` : null;
        return ref && answers.commitSha(ref) ? ref : null;
      },

      /**
       * The ref the scan starts from, or null when git cannot find one. `wanted` (--base) stays
       * exact. A loop.json branch that tracks a remote resolves to that remote branch, since a
       * local copy is often old; next comes the branch itself, then `<remote>/<branch>` when the
       * repo has one remote.
       */
      base: () => {
        const configured = config.base;
        if (wanted) return answers.commitSha(wanted) ? wanted : null;
        if (!configured) return null;

        const upstream = answers.run([
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          `${configured}@{upstream}`,
        ]);
        if (upstream) return upstream;
        return answers.commitSha(configured) ? configured : scanner.remoteBranch(configured);
      },

      /**
       * Where a review's change starts: the merge base of HEAD and the base, as check's scan
       * finds it. Null when --base names a ref git cannot find; throws when there is no base.
       */
      range: () => {
        const ref = scanner.base();
        if (!ref && wanted) return null;
        const start = ref ? answers.run(["merge-base", ref, "HEAD"]) : null;
        if (!start) {
          throw new Error('no base found to review from; set "base" in loop.json or pass --base');
        }
        return { ref, start };
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
        return [tracked, ...untracked.map((file) => scanner.addedFile(file))].join("\n");
      },

      /** Quick-scan hits on the added lines of a unified diff, once per finding id. */
      hits: (diff: string) => {
        const hits = scanner.addedLines(diff).flatMap((added) => {
          const code = added.text.trim();
          const shown = code.length > 120 ? `${code.slice(0, 117)}...` : code;
          return scans
            .filter((rule) => rule.pattern.test(code))
            .map((rule) => {
              const hit = {
                rule: rule.rule,
                severity: "question",
                file: added.file,
                line: added.line,
                summary: `${rule.topic}: ${shown}`,
                trigger:
                  "Quick-scan grep hit on an added line. Read the code before you call it a problem.",
                fix: rule.fix,
                source: "check",
              };
              return { id: files.findingId(hit), ...hit };
            });
        });
        return hits.filter(
          (hit, index) => hits.findIndex((other) => other.id === hit.id) === index,
        );
      },

      /**
       * Check's scan of the change: whether it ran, its hits, and the lines check prints first,
       * where it started or why it was skipped. `untracked` is the list from before the gates.
       */
      check: (untracked: string[] | null) => {
        const ref = scanner.base();
        const diff = ref ? scanner.diff(ref, untracked) : null;
        if (diff !== null) {
          return { scanned: true, hits: scanner.hits(diff), notes: [`scan base: ${ref}`] };
        }

        const why = ref ? `git cannot diff from ${ref}` : "no base found; pass --base <ref>";
        const skipped = wanted && !ref ? `git cannot find --base ${wanted}` : why;
        const notes = [`scan skipped: ${skipped}`, "earlier scan findings stay as they are"];
        return { scanned: false, hits: [], notes };
      },
    };

    return scanner;
  },
});
