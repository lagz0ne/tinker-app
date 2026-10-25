import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resource } from "@tinker/core";
import { z } from "zod";

import { appDir } from "@/tags";

/** The longest timer Node can set; a longer one fires at once. */
const maxTimeoutMs = 2_147_483_647;

const wholeMs = "must be a positive whole number of milliseconds";
const nameAndRun = 'each gate needs a "name" and a "run" string';
const listed = '"gates" must list at least one gate';
const words = '"review.command" must list the program and its arguments as strings';

/** A `timeout` in loop.json: Node timers take whole ms up to 2^31 - 1. */
const timeoutMs = z
  .number({ error: wholeMs })
  .int({ error: wholeMs })
  .positive({ error: wholeMs })
  .max(maxTimeoutMs, { error: `must be at most ${maxTimeoutMs} ms, about 24 days` });

/**
 * loop.json, checked: its gates (each with a name, a run, and its own log file), its base
 * branch, and its optional review block (the reviewer's argv and timeout). The checks run in file
 * order, so the first refusal is the first problem, in the words the tool printed before the port.
 */
const loopFile = z.preprocess(
  (raw) => raw ?? {},
  z.looseObject(
    {
      gates: z
        .array(
          z
            .looseObject(
              {
                name: z.string({ error: nameAndRun }).min(1, { error: nameAndRun }),
                run: z.string({ error: nameAndRun }),
                timeout: z.unknown().optional(),
              },
              { error: nameAndRun },
            )
            .superRefine((gate, ctx) => {
              const timeout = timeoutMs.optional().safeParse(gate.timeout);
              if (timeout.success) return;
              const problem = timeout.error.issues[0]?.message;
              ctx.addIssue({ code: "custom", message: `gate ${gate.name}: "timeout" ${problem}` });
            })
            .pipe(
              z.looseObject({ name: z.string(), run: z.string(), timeout: timeoutMs.optional() }),
            ),
          { error: listed },
        )
        .min(1, { error: listed })
        .superRefine((gates, ctx) => {
          const names = new Set(gates.map((gate) => gate.name));
          const logs = new Set(gates.map((gate) => gate.name.replaceAll(/[^\w.-]/g, "-")));
          if (names.size !== gates.length) {
            ctx.addIssue({ code: "custom", message: "gate names must differ" });
          } else if (logs.size !== gates.length) {
            ctx.addIssue({
              code: "custom",
              message:
                "gate names must differ after each character other than a letter, digit, '.', '_', or '-' becomes '-', since each names a log file",
            });
          }
        }),
      base: z
        .unknown()
        .optional()
        .transform((base) => (typeof base === "string" ? base : null)),
      review: z
        .looseObject(
          {
            command: z
              .array(z.string({ error: words }).min(1, { error: words }), { error: words })
              .min(1, { error: words })
              .optional(),
            timeout: timeoutMs.optional(),
          },
          { error: '"review" must be an object' },
        )
        .default({}),
    },
    { error: listed },
  ),
);

/**
 * The app's loop.json, read and checked. A missing file, a file that is not JSON, or a refused
 * field fails with the message the tool printed before the port: the seam prints it and exits 78.
 * A timeout's message names its gate, or `review.timeout`.
 */
export const loopConfig = resource({
  label: "loop.config",
  depends: { appDir },
  factory: ({ appDir: app }) => {
    const path = join(app, "loop.json");
    if (!existsSync(path)) throw new Error(`${path} is missing`);

    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const read = loopFile.safeParse(raw);
    if (read.success) return read.data;

    const issue = read.error.issues[0];
    const [where, field] = issue?.path ?? [];
    const prefix = where === "review" && field === "timeout" ? '"review.timeout" ' : "";
    const problem = `${prefix}${issue?.message}`;
    throw new Error(`${path}: ${problem}`);
  },
});
