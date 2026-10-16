import { z } from "zod";

export const commentRecord = z.object({
  id: z.uuid(),
  issueId: z.uuid(),
  authorId: z.string(),
  body: z.string(),
  createdAt: z.string(),
});

export type Comment = z.infer<typeof commentRecord>;

export const commentDraft = z
  .object({
    teamId: z.uuid(),
    issueId: z.uuid(),
    body: z.string().trim().min(1).max(5000),
  })
  .strict();

export const commentCommand = z.object({ executionId: z.uuid(), comment: commentDraft }).strict();
