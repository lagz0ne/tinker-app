import { tag } from "@tinker/core";
import type { Operation } from "@tinker/core";
import { z } from "zod";

/** A tool's reply, as obelisk's `reply`: plain text, or text with `data` for `structuredContent`. */
export type McpReply = string | { text: string; data?: Record<string, unknown> };

/** The Core operation a tool runs; its own `input` reader is the only parse of the arguments. */
type ToolRun = Operation.Handle<McpReply | Promise<McpReply>, unknown>;

const toolName = /^[a-z][a-z0-9_]{0,63}$/;

const toolRow = z.strictObject({
  name: z.string().regex(toolName, {
    error: (issue) => `Tool name ${JSON.stringify(issue.input)} must match ${toolName}.`,
  }),
  title: z.string(),
  description: z.string(),
  hints: z
    .strictObject({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
  input: z.instanceof(z.ZodObject),
  run: z
    .unknown()
    .refine(
      (value): value is ToolRun =>
        typeof value === "object" && value !== null && "label" in value && "run" in value,
      { error: "A tool runs a Core operation." },
    ),
});

export type McpTool = z.output<typeof toolRow>;

/** Only the names, to say which one a list repeats. */
const toolNames = z.array(z.object({ name: z.string() }));

/** What the server tells a client at initialize. */
export const mcpServer = tag({
  label: "mcp.server",
  parse: z.strictObject({
    name: z.string().min(1),
    version: z.string().min(1),
    instructions: z.string().optional(),
  }),
});

/**
 * The tools, as data: each row's zod `input` is both the listed JSON Schema and the one parse of
 * its operation. Names are unique and checked when the tag is bound.
 */
export const mcpTools = tag({
  label: "mcp.tools",
  parse: z
    .array(toolRow)
    .refine(
      (rows) =>
        rows.every(({ name }, index) => rows.findIndex((row) => row.name === name) === index),
      {
        error: (issue) => {
          const names = toolNames.parse(issue.input).map(({ name }) => name);
          const twice = names.find((name, index) => names.indexOf(name) !== index);

          return `Tool name ${JSON.stringify(twice)} is used twice.`;
        },
      },
    ),
});
