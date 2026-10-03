import { z } from "zod";
import {
  eventEnvelope,
  snapshotEnvelope,
  batchEnvelope,
  bootstrapEnvelope,
} from "../scaffold/sync.ts";
export { readExecution, readCursor, readPrivateCursor, readRetry } from "../scaffold/sync.ts";
export type { Sync } from "../scaffold/sync.ts";
export declare namespace FeatureSync {
  type Change = z.infer<typeof change>;
  type Result = z.infer<typeof result>;
  type Public = z.infer<typeof snapshot>["public"];
  type Private = NonNullable<z.infer<typeof snapshot>["private"]>;
}
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
const event = eventEnvelope.extend({
  payload: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("change"), change }),
    z.object({ kind: z.literal("result"), result }),
  ]),
});
const snapshot = snapshotEnvelope.extend({
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
export const readSnapshot = snapshot;
const bootstrapInput = bootstrapEnvelope.extend({ snapshot });
export const readBootstrap = bootstrapInput;
const batchInput = batchEnvelope.extend({
  events: z.array(event),
});
export const readBatch = batchInput;
export const streamMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("changes"), events: z.array(event).max(100) }),
  z.object({ kind: z.literal("account-change") }),
]);
export const readFeatureResult = result;
/**
 * @param raw - From a saved event row; why: validate its feature body before replay.
 */
export const readFeatureEvent = (raw: unknown) => event.parse(raw);
