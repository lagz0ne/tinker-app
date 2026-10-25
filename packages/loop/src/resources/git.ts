import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { resource } from "@tinker/core";

import { appDir, childEnv } from "@/tags";

/**
 * git in the app folder, with only the childEnv tag for env. Each call is short, so it runs to
 * its end and owns nothing on close. A failed call answers null.
 */
export const git = resource({
  label: "loop.git",
  depends: { appDir, childEnv },
  factory: ({ appDir: app, childEnv: env }) => {
    const answers = {
      /** Run git; its trimmed stdout, or all of it when `raw`, or null when git failed. */
      run: (args: string[], { raw = false } = {}) => {
        const result = spawnSync("git", args, {
          cwd: app,
          env: { ...env },
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
        });
        if (result.status !== 0) return null;
        return raw ? result.stdout : result.stdout.trim();
      },
      /** The commit a ref names, or null. `--end-of-options` keeps a ref from reading as a flag. */
      commitSha: (ref: string) =>
        answers.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]),
      headSha: () => answers.commitSha("HEAD"),
      /** True when `older` is in the history of `newer`. */
      inHistory: (older: string, newer: string) =>
        answers.run(["merge-base", "--is-ancestor", older, newer]) !== null,
      /**
       * Why `commit` cannot close a finding: it must be in HEAD's history and come after
       * `seenSha`, the HEAD when a tool last saw the finding. A row with no `seenSha` takes only a
       * fix `named` with --sha. Null when it can close it.
       */
      fixOrder: (commit: string, row: { id: string; seenSha?: string }, named: boolean) => {
        const head = answers.headSha() ?? "HEAD";
        const { id, seenSha: seen } = row;

        if (!answers.inHistory(commit, head)) {
          return `commit ${commit.slice(0, 12)} is not in HEAD's history`;
        }
        if (!seen) {
          return named
            ? null
            : `finding ${id} has no seenSha, so no tool recorded where it was seen; name the fix commit with --sha`;
        }
        if (!answers.inHistory(seen, head)) {
          return `finding ${id} was seen at ${seen.slice(0, 12)}, which is no longer in HEAD's history (amended or rebased); run tinker-loop check, or the tool that saw it, again`;
        }
        if (commit === seen || !answers.inHistory(seen, commit)) {
          return `finding ${id} was seen at ${seen.slice(0, 12)}; commit the fix after it, then answer`;
        }
        return null;
      },
      /** The app folder's path inside its repo, "." at the top, or the folder itself outside git. */
      appScope: () => {
        const prefix = answers.run(["rev-parse", "--show-prefix"]);
        if (prefix === null) return app;
        return prefix.replace(/\/$/, "") || ".";
      },
      /** The top folder of the app's repo, or null outside git. */
      top: () => answers.run(["rev-parse", "--show-toplevel"]),
      /**
       * The app folder's work tree: its untracked files (null outside git), whether it has
       * uncommitted changes, and a fingerprint of them: `git diff HEAD` and each untracked
       * file's name and bytes (a link's target; a gone file adds nothing). Two equal
       * fingerprints at one HEAD mean the same work tree.
       */
      tree: () => {
        const listed = answers.run(["ls-files", "--others", "--exclude-standard", "-z"], {
          raw: true,
        });
        const status = answers.run(["status", "--porcelain", "--untracked-files=all", "--", "."]);
        const untracked = listed?.split("\0").filter(Boolean) ?? null;
        const diff = answers.run(["diff", "--no-ext-diff", "--binary", "HEAD", "--", "."], {
          raw: true,
        });

        let fingerprint: string | null = null;
        if (diff !== null && untracked !== null) {
          const hash = createHash("sha256").update(diff);
          for (const file of untracked.toSorted()) {
            const path = join(app, file);
            hash.update(`\0${file}\0`);
            try {
              hash.update(
                lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path),
              );
            } catch {
              hash.update("");
            }
          }
          fingerprint = hash.digest("hex");
        }
        return { untracked, dirty: Boolean(status), fingerprint };
      },
    };

    return answers;
  },
});
