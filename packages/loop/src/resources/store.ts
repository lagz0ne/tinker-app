import {
  appendFileSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { resource } from "@tinker/core";
import { z } from "zod";

import { appDir } from "@/tags";

/** One findings row: a JSON object with a string id; the operations read the rest. */
const finding = z.looseObject({ id: z.string() });

/** One review round row: a JSON object with a whole-number round. */
const round = z.looseObject({ round: z.int() });

/**
 * A lock older than this is stale: a tool holds it for one read, merge, and write, a few
 * milliseconds. Age is the only rule; a pid means nothing across the sandbox and the host.
 */
const staleLockMs = 10_000;

/** How long a tool waits for the lock. Longer than staleLockMs, so a stale lock always breaks. */
const lockWaitMs = 15_000;

/**
 * The app's loop state in `.loop/`: the findings file, the review rounds, the last check, and
 * the findings lock. Time comes from ctx.clock and the lock token and temp names from
 * ctx.random, never from the process. Close releases a lock a stopped update still holds.
 */
export const store = resource({
  label: "loop.store",
  depends: { appDir },
  factory: ({ appDir: app }, { clock, random, defer }) => {
    const folder = join(app, ".loop");
    const lockPath = join(folder, "findings.lock");
    let held: string | null = null;

    /** Make `.loop`; it ignores itself, so git never commits loop state. */
    const ensure = () => {
      mkdirSync(folder, { recursive: true });
      if (!existsSync(join(folder, ".gitignore"))) writeFileSync(join(folder, ".gitignore"), "*\n");
      return folder;
    };
    /** Replace a file in one rename, so a stopped run never leaves half a file. */
    const replace = (name: string, text: string) => {
      const path = join(ensure(), name);
      const temp = `${path}.${random.uuid()}.tmp`;
      writeFileSync(temp, text);
      renameSync(temp, path);
    };
    /** The JSON lines of a file, each with its line number; a missing file has none. */
    const rows = (name: string) => {
      const path = join(folder, name);
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line, index) => ({ path, number: index + 1, line: line.trim() }))
        .filter(({ line }) => line);
    };
    const json = (line: string) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    };

    const age = (path: string) => {
      try {
        return clock.currentTimeMillis() - statSync(path).mtimeMs;
      } catch {
        return 0;
      }
    };
    const tryLock = (token: string) => {
      try {
        const file = openSync(lockPath, "wx");
        writeFileSync(file, token);
        closeSync(file);
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === "EEXIST") return false;
        throw error;
      }
    };
    const breakLock = (token: string) => {
      const aside = `${lockPath}.${token}.stale`;
      try {
        renameSync(lockPath, aside);
      } catch {
        return;
      }

      if (age(aside) <= staleLockMs) {
        try {
          linkSync(aside, lockPath);
        } catch {
          // A new lock already took the name; this one was released or broken.
        }
      }
      rmSync(aside, { force: true });
    };
    const release = (token: string) => {
      held = null;
      try {
        if (readFileSync(lockPath, "utf8") === token) rmSync(lockPath);
      } catch {
        // The lock was broken as stale; it is not ours to remove.
      }
    };
    const lock = async () => {
      ensure();
      const token = random.uuid();
      const deadline = clock.currentTimeMillis() + lockWaitMs;
      for (;;) {
        if (tryLock(token)) return (held = token);
        if (age(lockPath) > staleLockMs) breakLock(token);
        else if (clock.currentTimeMillis() > deadline) {
          throw new Error(`${lockPath} is held by another tool; delete it if no tool is running`);
        } else await clock.sleep(50);
      }
    };

    defer(() => {
      if (held) release(held);
    });

    return {
      /** Make `.loop` and return its path, for files such as the review's. */
      folder: ensure,
      /** Run `work` under `.loop/findings.lock`, so two tools never drop each other's rows. */
      locked: async <T>(work: () => T | Promise<T>) => {
        const token = await lock();
        try {
          return await work();
        } finally {
          release(token);
        }
      },
      /** Every findings row, in file order. Read it inside `locked` when you write it back. */
      findings: () =>
        rows("findings.jsonl").map(({ path, number, line }) => {
          const row = finding.safeParse(json(line));
          if (!row.success) {
            throw new Error(`${path}:${number} is not a finding: one JSON object with a string id`);
          }
          return row.data;
        }),
      /** Replace the findings file. Call it inside `locked`. */
      writeFindings: (findings: z.infer<typeof finding>[]) => {
        const text = findings.map((row) => JSON.stringify(row)).join("\n");
        replace("findings.jsonl", text ? `${text}\n` : "");
      },
      /** Each recorded review round, in file order. */
      rounds: () =>
        rows("rounds.jsonl").map(({ path, number, line }) => {
          const row = round.safeParse(json(line));
          if (!row.success) {
            throw new Error(
              `${path}:${number} is not a round: one JSON object with a whole-number round; fix or delete that line`,
            );
          }
          return row.data;
        }),
      /** Add one review round. Call it inside `locked`. */
      appendRound: (row: z.infer<typeof round>) => {
        appendFileSync(join(ensure(), "rounds.jsonl"), `${JSON.stringify(row)}\n`);
      },
      /** What the last check run saw, or null before the first check. */
      lastCheck: () => {
        const path = join(folder, "last-check.json");
        if (!existsSync(path)) return null;
        try {
          return JSON.parse(readFileSync(path, "utf8")) as unknown;
        } catch (error) {
          throw new Error(
            `${path}: ${(error as Error).message}; run tinker-loop check to write it again`,
          );
        }
      },
      /** Save what a check run saw, in one rename. */
      writeLastCheck: (run: unknown) => {
        replace("last-check.json", `${JSON.stringify(run)}\n`);
      },
    };
  },
});
