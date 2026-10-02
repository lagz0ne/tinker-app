import { z } from "zod";
/** User code merges this open registry to supply its feature bodies. */
export interface Register {}
export declare namespace Sync {
  type Change = Register extends { change: infer T } ? T : unknown;
  type Result = Register extends { result: infer T } ? T : unknown;
  type Public = { stream: "public"; revision: number } & (Register extends { public: infer T }
    ? T
    : unknown);
  type Private = { stream: string; revision: number } & (Register extends { private: infer T }
    ? T
    : unknown);
  type Snapshot = { public: Public; private: Private | null };
  type Payload = { kind: "change"; change: Change } | { kind: "result"; result: Result };
  type Event = { stream: string; revision: number; executionId: string; payload: Payload };
  type Envelope = z.infer<typeof eventEnvelope>;
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
/** Bodies are opaque here; the app's network readers validate them. */
export const eventEnvelope = z.object({
  stream: z.string(),
  revision: z.number().int().positive(),
  executionId: z.uuid(),
  payload: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("change"), change: z.unknown() }),
    z.object({ kind: z.literal("result"), result: z.unknown() }),
  ]),
});
export const snapshotEnvelope = z.object({
  public: z.object({ stream: z.literal("public"), revision: z.number().int().min(0) }).loose(),
  private: z
    .object({ stream: z.string(), revision: z.number().int().min(0) })
    .loose()
    .nullable(),
});
export const batchEnvelope = z.object({
  version: z.number().int().min(0),
  events: z.array(eventEnvelope),
});
export const bootstrapEnvelope = z.object({
  version: z.number().int().min(0),
  snapshot: snapshotEnvelope,
});
export const streamEnvelope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("changes"), events: z.array(eventEnvelope).max(100) }),
  z.object({ kind: z.literal("account-change") }),
]);
export const streamInput = z.object({ version: z.number().int().min(0), data: z.string() });
