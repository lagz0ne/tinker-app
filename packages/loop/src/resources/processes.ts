import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

import { resource } from "@tinker/core";

import { appDir, childEnv } from "@/tags";

import type { LoopFile } from "./loop-config";

/** A command with no `timeout` stops after 20 minutes. */
const defaultTimeoutMs = 20 * 60 * 1000;

/** After SIGTERM, a stopped group has this long to end before SIGKILL; then 1 second more. */
const killGraceMs = 5000;

/**
 * Child process groups (S4, S6). Each command runs in its own group, in appDir, with only the
 * childEnv tag for env. This resource owns every group it starts: on the command's timeout, the
 * caller's stop, or the root's close, the group gets SIGTERM, then SIGKILL after 5 seconds, and
 * is gone within 6. That fits inside the host's 10-second grace. Close waits for every stop.
 */
export const processes = resource({
  label: "loop.processes",
  depends: { appDir, childEnv },
  factory: ({ appDir: cwd, childEnv: env }, { clock, closing, defer }) => {
    const stopping = new Set<Promise<void>>();
    defer(async () => {
      await Promise.all(stopping);
    });

    /** Signal the group; false once it is gone. Signal 0 only asks if it lives. */
    const signalGroup = (pid: number | undefined, signal: NodeJS.Signals | 0) => {
      try {
        if (pid) process.kill(-pid, signal);
        return Boolean(pid);
      } catch {
        return false;
      }
    };
    const waitGone = async (pid: number | undefined, limit: number) => {
      for (let waited = 0; waited < limit && signalGroup(pid, 0); waited += 50) {
        await clock.sleep(50);
      }
    };
    const stopGroup = async (pid: number | undefined) => {
      signalGroup(pid, "SIGTERM");
      await waitGone(pid, killGraceMs);
      signalGroup(pid, "SIGKILL");
      await waitGone(pid, 1000);
    };

    /**
     * Run one command to its end. Its stdin is the `input` file, or empty. A string runs in a
     * shell; an array runs as is. Resolves null when it exited 0, else how it ended.
     */
    const run = (
      job: {
        /** A gate's `run` (a shell line), or the review's argv. */
        command: LoopFile["gates"][number]["run"] | NonNullable<LoopFile["review"]["command"]>;
        timeout?: LoopFile["gates"][number]["timeout"];
        input?: string;
        out: string;
        err?: string;
      },
      signal?: AbortSignal,
    ) => {
      const input = job.input ? openSync(job.input, "r") : ("ignore" as const);
      const out = openSync(job.out, "w");
      const err = job.err ? openSync(job.err, "w") : out;
      const timeout = job.timeout ?? defaultTimeoutMs;
      const options = { cwd, env: { ...env }, detached: true, stdio: [input, out, err] };
      const child = Array.isArray(job.command)
        ? spawn(job.command[0], job.command.slice(1), options)
        : spawn(job.command, { ...options, shell: true });

      let ending: string | null = null;
      let stopped: Promise<void> | undefined;
      const stop = (why: string) => {
        ending ??= why;
        if (stopped) return;
        stopped = stopGroup(child.pid);
        stopping.add(stopped);
      };
      const timer = new AbortController();
      clock.sleep(timeout, timer.signal).then(
        () => stop(`timed out after ${timeout} ms`),
        () => {},
      );
      const halt = () => stop("was stopped");
      signal?.addEventListener("abort", halt, { once: true });
      closing.addEventListener("abort", halt, { once: true });

      return new Promise<string | null>((resolve) => {
        let finished = false;
        const done = async (end: string | null) => {
          if (finished) return;

          finished = true;
          timer.abort();
          signal?.removeEventListener("abort", halt);
          closing.removeEventListener("abort", halt);
          await stopped;
          for (const fd of new Set([out, err])) closeSync(fd);
          if (input !== "ignore") closeSync(input);
          resolve(ending ?? end);
        };
        child.once("error", (error) => void done(`could not start: ${error.message}`));
        child.once("close", (code, killed) => {
          if (code === 0) void done(null);
          else void done(killed ? `was stopped by ${killed}` : `exited with code ${code}`);
        });
      });
    };

    return { run };
  },
});
