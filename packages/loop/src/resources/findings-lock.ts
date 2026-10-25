import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { resource } from "@tinker/core";

import { appDir } from "@/tags";

import { store } from "./store";

/**
 * A lock older than this is stale: a tool holds it for one read, merge, and write, a few
 * milliseconds. Age is the only rule; a pid means nothing across the sandbox and the host.
 */
const staleLockMs = 10_000;

/** How long a tool waits for the lock. Longer than staleLockMs, so a stale lock always breaks. */
const lockWaitMs = 15_000;

/**
 * `.loop/findings.lock`, so two tools never drop each other's findings rows. Time comes from
 * ctx.clock and the token from ctx.random, never from the process. An operation takes the lock,
 * reads, merges, and writes, then releases it in a finally. Close waits for every hold, since
 * Core waits only for its own work: releasing the lock under a running write lets another writer
 * in, and the late write then drops that writer's rows.
 */
export const findingsLock = resource({
  label: "loop.findingsLock",
  depends: { appDir, store },
  factory: ({ appDir: app, store: files }, { clock, random, defer, closing }) => {
    const path = join(app, ".loop", "findings.lock");
    const holds = new Map<string, () => void>();
    const running = new Set<Promise<void>>();
    defer(async () => {
      await Promise.allSettled(running);
    });

    const lock = {
      /** How old a lock file is on ctx.clock; 0 when it is gone. */
      age: (file: string) => {
        try {
          return clock.currentTimeMillis() - statSync(file).mtimeMs;
        } catch {
          return 0;
        }
      },
      /** Take the free lock with `token`; false when another tool holds it. */
      claim: (token: string) => {
        try {
          const file = openSync(path, "wx");
          writeFileSync(file, token);
          closeSync(file);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw error;
        }
      },
      /**
       * Move a stale lock aside. When it turns out fresh (a tool took it meanwhile), put it
       * back, unless a new lock already took the name.
       */
      breakStale: (token: string) => {
        const aside = `${path}.${token}.stale`;
        try {
          renameSync(path, aside);
        } catch {
          return;
        }

        if (lock.age(aside) <= staleLockMs) {
          try {
            linkSync(aside, path);
          } catch {
            // A new lock already took the name; this one was released or broken.
          }
        }
        rmSync(aside, { force: true });
      },
      /** Count a taken lock as running work, so close waits for its release. */
      hold: (token: string) => {
        const hold = new Promise<void>((resolve) => holds.set(token, resolve));
        running.add(hold);
        void hold.then(() => running.delete(hold));
        return token;
      },
      /** Release the lock, when it is still ours, and end its hold. */
      release: (token: string) => {
        holds.get(token)?.();
        holds.delete(token);
        try {
          if (readFileSync(path, "utf8") === token) rmSync(path);
        } catch {
          // The lock was broken as stale; it is not ours to remove.
        }
      },
      /**
       * Take the lock, waiting while another tool holds it, and return its token; release it in
       * a finally. The wait ends on the root's close and on the caller's stop, so a stopped tool
       * exits by its signal and takes no lock.
       */
      take: async (stop?: AbortSignal) => {
        files.folder();
        const token = random.uuid();
        const deadline = clock.currentTimeMillis() + lockWaitMs;
        const halt = stop ? AbortSignal.any([closing, stop]) : closing;
        for (;;) {
          if (lock.claim(token)) return lock.hold(token);
          if (lock.age(path) > staleLockMs) lock.breakStale(token);
          else if (clock.currentTimeMillis() > deadline) {
            throw new Error(`${path} is held by another tool; delete it if no tool is running`);
          } else await clock.sleep(50, halt);
        }
      },
    };

    return lock;
  },
});
