import { z } from "zod";
/** The app merges this open registry to supply its feature bodies. */
export interface Register {}
export declare namespace Sync {
  type Change = Register extends { change: infer T } ? T : unknown;
  type Result = Register extends { result: infer T } ? T : unknown;
  type Public = Register extends { public: infer T }
    ? { stream: "public"; revision: number } & T
    : { stream: "public"; revision: number };
  type Private = Register extends { private: infer T }
    ? { stream: string; revision: number } & T
    : { stream: string; revision: number };
  type Snapshot = { public: Public; private: Private | null };
  type Payload = { kind: "change"; change: Change } | { kind: "result"; result: Result };
  type Event = { stream: string; revision: number; executionId: string; payload: Payload };
  type Envelope = z.infer<typeof eventEnvelope>;
  type Receipt = { executionId: string };
  type Reply = { kind: "accepted"; executionId: string } | { kind: "rejected"; message: string };
  /** The router context sync adds: a route's loader or guard calls these. */
  type RouterContext = {
    bootstrap: () => Promise<Snapshot>;
    account: () => Promise<string | null>;
  };
}
const executionInput = z.object({ executionId: z.uuid() }).strict();
/**
 * @param raw - From a mutation request; why: validate its execution ID.
 */
export const readExecution = (raw: unknown) => executionInput.parse(raw);
export const readCursor = z.object({ after: z.number().int().min(0) }).strict();
export const readPrivateCursor = z
  .object({ accountId: z.string().min(1), after: z.number().int().min(0) })
  .strict();
const retryInput = z.object({ executionId: z.uuid(), previousExecutionId: z.uuid() }).strict();
/**
 * @param raw - From a retry request; why: validate both execution IDs.
 */
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
/** One stream frame as the tab hands it on: the account version it was read under, and its data. */
export const streamInput = z.object({ version: z.number().int().min(0), data: z.string() });
