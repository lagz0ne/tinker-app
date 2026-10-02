import { z } from "zod";
export declare namespace Sync {
  type Result = z.infer<typeof result>;
  type Change = z.infer<typeof change>;
  type Payload = Event["payload"];
  type Event = z.infer<typeof event>;
  type Snapshot = z.infer<typeof snapshot>;
  type Receipt = { executionId: string };
  type Reply = { kind: "accepted"; executionId: string } | { kind: "rejected"; message: string };
}
const executionInput = z.object({ executionId: z.uuid() }).strict();
export const readExecution = (raw: unknown) => executionInput.parse(raw);
const cursorInput = z.object({ after: z.number().int().min(0) }).strict();
export const readCursor = (raw: unknown) => cursorInput.parse(raw);
const privateCursorInput = z
  .object({ accountId: z.string().min(1), after: z.number().int().min(0) })
  .strict();
export const readPrivateCursor = (raw: unknown) => privateCursorInput.parse(raw);
const retryInput = z.object({ executionId: z.uuid(), previousExecutionId: z.uuid() }).strict();
export const readRetry = (raw: unknown) => retryInput.parse(raw);
const profileRecord = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
});
const todoRecord = z.object({ id: z.number(), title: z.string(), done: z.boolean() });
const result = z.union([
  z.object({ kind: z.literal("complete"), action: z.enum(["counter", "todo"]) }),
  z.object({ kind: z.literal("complete"), action: z.literal("profile"), profileId: z.string() }),
  z.object({
    kind: z.literal("partial"),
    action: z.literal("profile"),
    profileId: z.string(),
    notification: z.object({ kind: z.literal("failed"), message: z.string() }),
  }),
  z.object({
    kind: z.literal("failed"),
    action: z.enum(["counter", "todo", "profile"]),
    message: z.string(),
  }),
]);
const change = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("counter"), value: z.number() }),
  z.object({ kind: z.literal("profile"), profile: profileRecord }),
  z.object({ kind: z.literal("todos"), rows: z.array(todoRecord) }),
]);
const event = z.object({
  stream: z.string(),
  revision: z.number().int().positive(),
  executionId: z.uuid(),
  payload: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("change"), change }),
    z.object({ kind: z.literal("result"), result }),
  ]),
});
const snapshot = z.object({
  public: z.object({
    stream: z.literal("public"),
    revision: z.number().int().min(0),
    value: z.number(),
  }),
  private: z
    .object({
      stream: z.string(),
      revision: z.number().int().min(0),
      profile: profileRecord,
      todos: z.array(todoRecord),
    })
    .nullable(),
});
export const readSnapshot = (raw: unknown) => snapshot.parse(raw);
const bootstrapInput = z.object({ version: z.number().int().min(0), snapshot });
export const readBootstrap = (raw: unknown) => bootstrapInput.parse(raw);
const batchInput = z.object({
  version: z.number().int().min(0),
  events: z.array(event),
});
export const readBatch = (raw: unknown) => batchInput.parse(raw);
const streamMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("changes"), events: z.array(event).max(100) }),
  z.object({ kind: z.literal("account-change") }),
]);
const streamInput = z.object({ version: z.number().int().min(0), data: z.string() });
export function readStreamMessage(raw: unknown) {
  const { version, data } = streamInput.parse(raw);
  return { version, message: streamMessage.parse(JSON.parse(data)) };
}
