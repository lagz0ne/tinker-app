import { spawnSync } from "node:child_process";

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
    };
  },
});
