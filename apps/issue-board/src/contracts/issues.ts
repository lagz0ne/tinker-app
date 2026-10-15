import { z } from "zod";

export const issueStates = ["backlog", "todo", "in_progress", "done", "canceled"] as const;

export const issueStateLabels = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  canceled: "Canceled",
};

export const issuePriorities = ["No priority", "Urgent", "High", "Normal", "Low"] as const;

export const issueRecord = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  teamKey: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  state: z.enum(issueStates),
  priority: z.number().int().min(0).max(4),
  assigneeId: z.string().nullable(),
  creatorId: z.string(),
  rank: z.string(),
  version: z.number().int().positive(),
});

export type Issue = z.infer<typeof issueRecord>;

const issueDraft = z.object({
  teamId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000),
  state: z.enum(issueStates),
  priority: z.number().int().min(0).max(4),
  assigneeId: z.string().min(1).nullable(),
});

export const issueChange = z.discriminatedUnion("kind", [
  issueDraft.extend({ kind: z.literal("create") }).strict(),
  issueDraft
    .extend({ kind: z.literal("edit"), id: z.uuid(), version: z.number().int().positive() })
    .strict(),
  z
    .object({
      kind: z.literal("move"),
      teamId: z.uuid(),
      id: z.uuid(),
      version: z.number().int().positive(),
      state: z.enum(issueStates),
      beforeId: z.uuid().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove"),
      teamId: z.uuid(),
      id: z.uuid(),
      version: z.number().int().positive(),
    })
    .strict(),
]);

export const issueCommand = z.object({ executionId: z.uuid(), change: issueChange }).strict();
