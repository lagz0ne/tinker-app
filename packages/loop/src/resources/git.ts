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
    /** Run git; its trimmed stdout, or all of it when `raw`, or null when git failed. */
    const run = (args: string[], { raw = false } = {}) => {
      const result = spawnSync("git", args, {
        cwd: app,
        env: { ...env },
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      if (result.status !== 0) return null;
      return raw ? result.stdout : result.stdout.trim();
    };
    /** The commit a ref names, or null. `--end-of-options` keeps a ref from reading as a flag. */
    const commitSha = (ref: string) =>
      run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);

    return {
      run,
      commitSha,
      headSha: () => commitSha("HEAD"),
      /** True when `older` is in the history of `newer`. */
      inHistory: (older: string, newer: string) =>
        run(["merge-base", "--is-ancestor", older, newer]) !== null,
      /** The app folder's path inside its repo, "." at the top, or the folder itself outside git. */
      appScope: () => {
        const prefix = run(["rev-parse", "--show-prefix"]);
        if (prefix === null) return app;
        return prefix.replace(/\/$/, "") || ".";
      },
      /** The top folder of the app's repo, or null outside git. */
      top: () => run(["rev-parse", "--show-toplevel"]),
      /**
       * The app folder's work tree: its untracked files (null outside git), whether it has
       * uncommitted changes, and a fingerprint of them: `git diff HEAD` and each untracked
       * file's name and bytes. Two equal fingerprints at one HEAD mean the same work tree.
       */
      tree: () => {
        const listed = run(["ls-files", "--others", "--exclude-standard", "-z"], { raw: true });
        const status = run(["status", "--porcelain", "--untracked-files=all", "--", "."]);
        const untracked = listed?.split("\0").filter(Boolean) ?? null;
        const diff = run(["diff", "--no-ext-diff", "--binary", "HEAD", "--", "."], { raw: true });

        const bytes = (file: string) => {
          try {
            const path = join(app, file);
            return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path);
          } catch {
            return "";
          }
        };
        let fingerprint: string | null = null;
        if (diff !== null && untracked !== null) {
          const hash = createHash("sha256").update(diff);
          for (const file of untracked.toSorted()) hash.update(`\0${file}\0`).update(bytes(file));
          fingerprint = hash.digest("hex");
        }
        return { untracked, dirty: Boolean(status), fingerprint };
      },
    };
  },
});
