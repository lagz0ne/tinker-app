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
    const stopping = new Map<number | undefined, Promise<void>>();
    defer(async () => {
      await Promise.all(stopping.values());
    });

    /** One command to run, and where its output goes. */
    type Job = {
      /** A gate's `run` (a shell line), or the review's argv. */
      command: LoopFile["gates"][number]["run"] | NonNullable<LoopFile["review"]["command"]>;
      timeout?: LoopFile["gates"][number]["timeout"];
      input?: string;
      out: string;
      err?: string;
    };

    const groups = {
      /** Signal a group; false once it is gone. Signal 0 only asks if it lives. */
      signal: (pid: number | undefined, signal: NodeJS.Signals | 0) => {
        try {
          if (pid) process.kill(-pid, signal);
          return Boolean(pid);
        } catch {
          return false;
        }
      },
      /** Wait until the group is gone, or `limit` ms passed. */
      waitGone: async (pid: number | undefined, limit: number) => {
        for (let waited = 0; waited < limit && groups.signal(pid, 0); waited += 50) {
          await clock.sleep(50);
        }
      },
      /** SIGTERM, then SIGKILL after the grace, then wait until the group is gone. */
      end: async (pid: number | undefined) => {
        groups.signal(pid, "SIGTERM");
        await groups.waitGone(pid, killGraceMs);
        groups.signal(pid, "SIGKILL");
        await groups.waitGone(pid, 1000);
      },
      /** End a group; close waits for every stop this resource started. */
      stop: (pid: number | undefined) => {
        const stopped = stopping.get(pid) ?? groups.end(pid);
        stopping.set(pid, stopped);
        return stopped;
      },
      /** A job's files: stdin from `input` or empty, stdout to `out`, stderr to `err` or `out`. */
      open: (job: Job) => {
        const out = openSync(job.out, "w");
        return {
          input: job.input ? openSync(job.input, "r") : ("ignore" as const),
          out,
          err: job.err ? openSync(job.err, "w") : out,
        };
      },
      /** Start a job's child in its own process group. A string runs in a shell; an array runs as is. */
      start: (command: Job["command"], stdio: ("ignore" | number)[]) => {
        const options = { cwd, env: { ...env }, detached: true, stdio };
        return Array.isArray(command)
          ? spawn(command[0], command.slice(1), options)
          : spawn(command, { ...options, shell: true });
      },
      /**
       * Run one command to its end. Its stdin is the `input` file, or empty. Resolves null when
       * it exited 0, else how it ended. The timeout, the caller's stop, and the root's close each
       * stop its group.
       */
      run: async (job: Job, signal?: AbortSignal) => {
        const fds = groups.open(job);
        const timeout = job.timeout ?? defaultTimeoutMs;
        const child = groups.start(job.command, Object.values(fds));

        const ended = new Promise<string | null>((resolve) => {
          child.once("error", (error) => resolve(`could not start: ${error.message}`));
          child.once("close", (code, killed) => {
            if (code === 0) resolve(null);
            else resolve(killed ? `was stopped by ${killed}` : `exited with code ${code}`);
          });
        });
        const done = new AbortController();
        const halt = AbortSignal.any([closing, ...(signal ? [signal] : [])]);
        const why = await Promise.race([
          ended.then(() => null),
          clock.sleep(timeout, done.signal).then(
            () => `timed out after ${timeout} ms`,
            () => null,
          ),
          new Promise<string>((resolve) => {
            // Start the stop at once: close waits only for the stops it can see.
            const once = { once: true, signal: done.signal };
            halt.addEventListener(
              "abort",
              () => {
                void groups.stop(child.pid);
                resolve("was stopped");
              },
              once,
            );
          }),
        ]);

        if (why) await groups.stop(child.pid);
        const end = await ended;
        done.abort();
        for (const fd of new Set(Object.values(fds))) if (fd !== "ignore") closeSync(fd);
        return why ?? end;
      },
    };

    return groups;
  },
});
