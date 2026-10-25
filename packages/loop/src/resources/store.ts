import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
export const finding = z
  .object({
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
  })
  .loose();

/** One review round row: a JSON object with a whole-number round. */
const round = z.object({ round: z.number().int() }).loose();

/** What the last check run saw: its round, its HEAD, its work tree's fingerprint, its gates. */
export const lastCheckRun = z
  .object({
    round: z.number().int(),
    sha: z.string().nullable(),
    tree: z.string().nullable().optional(),
    gates: z.array(z.object({ name: z.string(), green: z.boolean() }).loose()),
  })
  .loose();

/** A row's round, where it has one: findings, review rounds, and the last check count up. */
const numbered = z.object({ round: z.number().int() });

/** The first line that reads like an error, else the first line. */
const errorLine = /error|fail|assert|not ok|✗|×/i;

/** ANSI color and cursor codes, which a gate's log keeps and a summary drops. */
// oxlint-disable-next-line no-control-regex -- each ANSI code starts with the ESC character.
const ansi = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * The app's loop state in `.loop/`: the findings file, the review rounds, the last check, and
 * the gate logs. Temp names come from ctx.random, never from the process. The findings lock is
 * its own resource, findingsLock.
 */
export const store = resource({
  label: "loop.store",
  depends: { appDir },
  factory: ({ appDir: app }, { random }) => {
    const folder = join(app, ".loop");

    /** A run that stamps rows: its round and HEAD, as the last check saves them, and `dirty`. */
    type Stamp = Pick<z.infer<typeof lastCheckRun>, "round" | "sha"> &
      Pick<z.infer<typeof finding>, "dirty">;

    const files = {
      /** Make `.loop` and return its path; it ignores itself, so git never commits loop state. */
      folder: () => {
        mkdirSync(folder, { recursive: true });
        if (!existsSync(join(folder, ".gitignore"))) {
          writeFileSync(join(folder, ".gitignore"), "*\n");
        }
        return folder;
      },
      /** Replace a file in one rename, so a stopped run never leaves half a file. */
      replace: (name: string, text: string) => {
        const path = join(files.folder(), name);
        const temp = `${path}.${random.uuid()}.tmp`;
        writeFileSync(temp, text);
        renameSync(temp, path);
      },
      /**
       * The JSON lines of a file, each parsed (null when it is not JSON) with its path and line
       * number. A missing file has none.
       */
      jsonLines: (name: string) => {
        const path = join(folder, name);
        if (!existsSync(path)) return [];
        return readFileSync(path, "utf8")
          .split(/\r?\n/)
          .map((line, index) => ({ path, number: index + 1, line: line.trim() }))
          .filter(({ line }) => line)
          .map(({ number, line }) => {
            try {
              return { path, number, value: JSON.parse(line) as unknown };
            } catch {
              return { path, number, value: null };
            }
          });
      },
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
        ...(run.sha ? { seenSha: run.sha } : {}),
        round: run.round,
        status: "open",
      }),
      /** A finding this run found again: the latest fields, open unless answered. */
      seen: (old: z.infer<typeof finding>, now: z.infer<typeof finding>, run: Stamp) => {
        const { sha: _sha, dirty: _dirty, seenSha: _seen, ...kept } = old;
        const status = old.status === "answered" ? "answered" : "open";
        const seenSha = run.sha ? { seenSha: run.sha } : {};
        return { ...kept, ...now, ...seenSha, round: run.round, status };
      },
      /** A finding a run marks fixed: its round, the HEAD, and `dirty` when only the tree had it. */
      fixed: (old: z.infer<typeof finding>, run: Stamp) => {
        const fixed = { ...old, round: run.round, status: "fixed", sha: run.sha };
        return run.dirty ? { ...fixed, dirty: true } : fixed;
      },
      /**
       * A gate's log in `.loop/gates`: the file its output goes to, and the short path findings
       * show. Each character other than a letter, digit, `.`, `_`, or `-` becomes `-`.
       */
      gateLog: (name: string) => {
        const file = `${name.replaceAll(/[^\w.-]/g, "-")}.log`;
        const gates = join(files.folder(), "gates");
        mkdirSync(gates, { recursive: true });
        return { path: join(gates, file), shown: join(".loop", "gates", file) };
      },
      /**
       * The summary of a red gate's log: its first line that reads like an error, else its first
       * line, else how the gate ended; at most 200 characters.
       */
      gateError: (name: string, ending: string) => {
        const lines = readFileSync(files.gateLog(name).path, "utf8")
          .replaceAll(ansi, "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const line = lines.find((text) => errorLine.test(text)) ?? lines[0] ?? ending;
        return line.length > 200 ? `${line.slice(0, 197)}...` : line;
      },
      /** Every findings row, in file order. Read it under findingsLock when you write it back. */
      findings: () =>
        files.jsonLines("findings.jsonl").map(({ path, number, value }) => {
          const row = finding.safeParse(value);
          if (!row.success) {
            throw new Error(`${path}:${number} is not a finding: one JSON object with a string id`);
          }
          return row.data;
        }),
      /** Replace the findings file. Call it under findingsLock. */
      writeFindings: (findings: z.infer<typeof finding>[]) => {
        const text = findings.map((row) => JSON.stringify(row)).join("\n");
        files.replace("findings.jsonl", text ? `${text}\n` : "");
      },
      /** Each recorded review round, in file order. */
      rounds: () =>
        files.jsonLines("rounds.jsonl").map(({ path, number, value }) => {
          const row = round.safeParse(value);
          if (!row.success) {
            throw new Error(
              `${path}:${number} is not a round: one JSON object with a whole-number round; fix or delete that line`,
            );
          }
          return row.data;
        }),
      /** Add one review round. Call it under findingsLock. */
      appendRound: (row: z.infer<typeof round>) => {
        appendFileSync(join(files.folder(), "rounds.jsonl"), `${JSON.stringify(row)}\n`);
      },
      /** What the last check run saw, or null before the first check. */
      lastCheck: () => {
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
      },
      /** Save what a check run saw, in one rename. */
      writeLastCheck: (run: z.infer<typeof lastCheckRun>) => {
        files.replace("last-check.json", `${JSON.stringify(run)}\n`);
      },
      /**
       * The next round number: one more than any round in the findings, the review rounds, or
       * the last check. A last check that cannot be read counts as none. Call it under
       * findingsLock.
       */
      nextRound: () => {
        let last: unknown = null;
        try {
          last = files.lastCheck();
        } catch {
          // A broken last check has no round; check writes it again.
        }
        const all = [...files.findings(), ...files.rounds(), last];
        return Math.max(0, ...all.map((row) => numbered.safeParse(row).data?.round ?? 0)) + 1;
      },
    };

    return files;
  },
});
