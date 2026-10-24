import { createHash } from "node:crypto";
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

/**
 * One findings row: a JSON object with a string id. The other fields are the ones the tool
 * writes; a row may leave any of them out.
 */
export const finding = z.looseObject({
  id: z.string(),
  source: z.string().optional(),
  rule: z.string().optional(),
  severity: z.string().optional(),
  status: z.string().optional(),
  file: z.string().optional(),
  line: z.number().nullable().optional(),
  summary: z.string().optional(),
  trigger: z.string().optional(),
  fix: z.string().optional(),
  reason: z.string().optional(),
  round: z.number().optional(),
  sha: z.string().nullable().optional(),
  seenSha: z.string().optional(),
  dirty: z.boolean().optional(),
});

/** One review round row: a JSON object with a whole-number round. */
const round = z.looseObject({ round: z.int() });

/** What the last check run saw: its round, its HEAD, its work tree's fingerprint, its gates. */
export const lastCheckRun = z.looseObject({
  round: z.int(),
  sha: z.string().nullable(),
  tree: z.string().nullable().optional(),
  gates: z.array(z.looseObject({ name: z.string(), green: z.boolean() })),
});

/** A row's round, where it has one: findings, review rounds, and the last check count up. */
const numbered = z.object({ round: z.int() });

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
  factory: ({ appDir: app }, { clock, random, defer, closing }) => {
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
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
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
    /**
     * Take the lock, waiting while another tool holds it. The wait ends on the root's close and
     * on the caller's stop, so a stopped tool exits by its signal and takes no lock.
     */
    const lock = async (stop?: AbortSignal) => {
      ensure();
      const token = random.uuid();
      const deadline = clock.currentTimeMillis() + lockWaitMs;
      const halt = stop ? AbortSignal.any([closing, stop]) : closing;
      for (;;) {
        if (tryLock(token)) return (held = token);
        if (age(lockPath) > staleLockMs) breakLock(token);
        else if (clock.currentTimeMillis() > deadline) {
          throw new Error(`${lockPath} is held by another tool; delete it if no tool is running`);
        } else await clock.sleep(50, halt);
      }
    };

    /**
     * Close waits for every running `locked` callback, since Core waits only for its own work:
     * releasing the lock under a running callback lets another writer in, and the late write
     * then drops that writer's rows. Only then is a lock still held released.
     */
    const running = new Set<Promise<unknown>>();
    defer(async () => {
      await Promise.allSettled(running);
      if (held) release(held);
    });

    /**
     * Run `work` under `.loop/findings.lock`, so two tools never drop each other's rows. A stop
     * while another tool holds the lock rejects, and `work` does not run.
     */
    const locked = async <T>(work: () => T | Promise<T>, stop?: AbortSignal) => {
      const ran = (async () => {
        const token = await lock(stop);
        try {
          return await work();
        } finally {
          release(token);
        }
      })();
      running.add(ran);
      try {
        return await ran;
      } finally {
        running.delete(ran);
      }
    };
    /** Every findings row, in file order. Read it inside `locked` when you write it back. */
    const readFindings = () =>
      rows("findings.jsonl").map(({ path, number, line }) => {
        const row = finding.safeParse(json(line));
        if (!row.success) {
          throw new Error(`${path}:${number} is not a finding: one JSON object with a string id`);
        }
        return row.data;
      });
    /** Each recorded review round, in file order. */
    const readRounds = () =>
      rows("rounds.jsonl").map(({ path, number, line }) => {
        const row = round.safeParse(json(line));
        if (!row.success) {
          throw new Error(
            `${path}:${number} is not a round: one JSON object with a whole-number round; fix or delete that line`,
          );
        }
        return row.data;
      });
    /** What the last check run saw, or null before the first check. */
    const readLast = () => {
      const path = join(folder, "last-check.json");
      if (!existsSync(path)) return null;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        throw new Error(
          `${path}: ${(error as Error).message}; run tinker-loop check to write it again`,
        );
      }

      const run = lastCheckRun.safeParse(raw);
      if (!run.success) {
        throw new Error(`${path}: not a check run; run tinker-loop check to write it again`);
      }
      return run.data;
    };
    /**
     * The next round number: one more than any round in the findings, the review rounds, or
     * the last check. A last check that cannot be read counts as none. Call it inside `locked`.
     */
    const nextRound = () => {
      let last: unknown = null;
      try {
        last = readLast();
      } catch {
        // A broken last check has no round; check writes it again.
      }
      const all = [...readFindings(), ...readRounds(), last];
      return Math.max(0, ...all.map((row) => numbered.safeParse(row).data?.round ?? 0)) + 1;
    };
    /** Add one review round. Call it inside `locked`. */
    const appendRound = (row: z.infer<typeof round>) => {
      appendFileSync(join(ensure(), "rounds.jsonl"), `${JSON.stringify(row)}\n`);
    };

    /** A run that stamps rows: its round and the HEAD it saw. */
    /** A run that stamps rows: its round and HEAD, as the last check saves them, and `dirty`. */
    type Stamp = Pick<z.infer<typeof lastCheckRun>, "round" | "sha"> &
      Pick<z.infer<typeof finding>, "dirty">;
    const seenAt = (sha: Stamp["sha"]) => (sha ? { seenSha: sha } : {});

    return {
      /**
       * A stable id: the same problem gets the same id on every run, wherever its line moves.
       * Digit runs are folded, so a timing or count in a summary does not make a new id. A gate
       * finding passes no summary: one red gate is one finding, whatever its message.
       */
      findingId: (
        row: Required<Pick<z.infer<typeof finding>, "source" | "rule" | "file">> &
          Pick<z.infer<typeof finding>, "summary">,
      ) => {
        const key = [row.source, row.rule, row.file, (row.summary ?? "").replaceAll(/\d+/g, "#")];
        return createHash("sha256").update(key.join("\n")).digest("hex").slice(0, 12);
      },
      /** A new finding: open, at this run's round, seen at its HEAD. */
      opened: (row: z.infer<typeof finding>, run: Stamp) => ({
        ...row,
        ...seenAt(run.sha),
        round: run.round,
        status: "open",
      }),
      /** A finding this run found again: the latest fields, open unless answered. */
      seen: (old: z.infer<typeof finding>, now: z.infer<typeof finding>, run: Stamp) => {
        const { sha: _sha, dirty: _dirty, seenSha: _seen, ...kept } = old;
        const status = old.status === "answered" ? "answered" : "open";
        return { ...kept, ...now, ...seenAt(run.sha), round: run.round, status };
      },
      /** A finding a run marks fixed: its round, the HEAD, and `dirty` when only the tree had it. */
      fixed: (old: z.infer<typeof finding>, run: Stamp) => {
        const fixed = { ...old, round: run.round, status: "fixed", sha: run.sha };
        return run.dirty ? { ...fixed, dirty: true } : fixed;
      },
      /** Make `.loop` and return its path, for files such as the review's. */
      folder: ensure,
      locked,
      findings: readFindings,
      /** Replace the findings file. Call it inside `locked`. */
      writeFindings: (findings: z.infer<typeof finding>[]) => {
        const text = findings.map((row) => JSON.stringify(row)).join("\n");
        replace("findings.jsonl", text ? `${text}\n` : "");
      },
      rounds: readRounds,
      appendRound,
      lastCheck: readLast,
      nextRound,
      /**
       * Record one review round under the lock, and return its number. The review records it
       * before it writes that round's findings, so status counts every round.
       */
      recordReviewRound: (sha: Stamp["sha"]) =>
        locked(() => {
          const next = nextRound();
          appendRound({ round: next, source: "review", sha });
          return next;
        }),
      /** Save what a check run saw, in one rename. */
      writeLastCheck: (run: z.infer<typeof lastCheckRun>) => {
        replace("last-check.json", `${JSON.stringify(run)}\n`);
      },
    };
  },
});
