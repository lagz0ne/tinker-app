import type { Operation } from "@tinker/core";
import { z } from "zod";

// The shapes each layer gives the next (ADR 0048 words):
//   transport  moves text: ws, memory
//   protocol   gives text meaning: the codec and the reply envelope, shared by rpc and remoteData
//   rpc, remoteData deal in values only
// `meta`: string pairs beside the body (`m` in a socket message). Lowercase, as HTTP headers.

const meta = z.record(z.string().regex(/^[a-z0-9-]+$/), z.string());
/**
 * On a server, `left` aborts when the caller goes. It is data, not the run's signal: Core
 * disposes an aborted run's depends at once, so a stream could not clean up (F32). The server
 * run ends by itself once it sees `left`; then the transport closes the request session.
 */
const left = z.custom<AbortSignal>((v) => v instanceof AbortSignal).optional();

/**
 * Bytes beside the value: what a Blob gives, read once. A client sends a Blob (a File); the
 * server hands the implementation a body over the request's own stream, read only when it reads.
 * They go on their own POST, not in a socket frame: Bun hands a socket message whole, so a frame
 * would copy every byte into memory (Q7, as tRPC sends files on an HTTP link beside its wsLink).
 */
export type Body = {
  readonly type: string;
  stream(): ReadableStream<Uint8Array>;
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

/** A Blob, or the server's body over a request stream. */
export const bodyShape = z.custom<Body>(
  (v) => typeof Object(v).stream === "function" && typeof Object(v).type === "string",
);

const body = bodyShape.optional();

/** A bytes field's limits: the most bytes, and the content types it takes (the first is the default). */
export type BytesLimit = { readonly max: number; readonly types: readonly string[] };

// ---- transport: text
export const sendInput = z.object({ address: z.string(), text: z.string(), meta, body });

export const openInput = sendInput.extend({
  push: z.custom<(text: string) => void>((v) => typeof v === "function"),
  left,
});

/** Client: one text out, one text back. */
export type Send = Operation.Handle<Promise<string>, z.infer<typeof sendInput>>;
/** Client: one text out, texts pushed until the signal aborts or the link ends. */
export type Open = Operation.Handle<Promise<void>, z.infer<typeof openInput>>;
/** Server: the text reply, or null when no one answers the address. */
export type TextServe = Operation.Handle<Promise<string | null>, z.infer<typeof sendInput>>;
/** Server: pushes texts; false when no one answers the address. */
export type TextStream = Operation.Handle<Promise<boolean>, z.infer<typeof openInput>>;

// ---- protocol: values
/**
 * The envelope. A domain outcome (a todo that is gone) is a value: it rides in `value`, as the
 * contract's output shape says. A fault is the call's own, from a fixed set, as HTTP statuses:
 *   refused  a hook said no (it returned refuse(payload)), like 401/403
 *   failed   the server threw; the cause stays in the server log, like 500
 *   invalid  the input did not fit, like 400
 *   encode   the codec could not turn a value into text (a BigInt in JSON), like gRPC "marshal"
 *   decode   the codec could not read a text, like JSON-RPC -32700 Parse error
 *   link     the transport failed, like 502
 * An encode or decode fault says where: `payload.side` is "client" or "server". The cause and
 * stack go to that side's log, with the address, inside the run's trace.
 * A push carries `meta.traceparent`: the span that sent it, for the receiver to link (OTel messaging).
 */
export type Fault = "refused" | "failed" | "invalid" | "encode" | "decode" | "link";

export type Reply =
  | { ok: true; value: unknown; meta?: Record<string, string> }
  | { ok: false; kind: Fault; payload: unknown };

export const callInput = z.object({ address: z.string(), value: z.unknown(), meta, body });

export const watchInput = callInput.extend({
  push: z.custom<(reply: Reply) => void>((v) => typeof v === "function"),
  left,
});

/** Client: a value out; the reply back, as a value (never thrown). */
export type Call = Operation.Handle<Promise<Reply>, z.infer<typeof callInput>>;
/** Client: a value out; replies pushed until the signal aborts or the link ends. */
export type Watch = Operation.Handle<Promise<void>, z.infer<typeof watchInput>>;

/**
 * A definition the server protocol routes to: the addresses it has (its keys), and how it
 * answers. rpc and remoteData definitions are services as they are.
 */
export type Service = {
  readonly label: unknown;
  readonly addresses: readonly string[];
  readonly answer: Answer;
  readonly stream: Stream;
  /** The addresses that take bytes, with their limits: only these answer a POST. */
  readonly uploads?: Readonly<Record<string, BytesLimit>>;
};

/** Server, given by rpc and remoteData: a reply, or null when the address is not theirs. */
export type Answer = Operation.Handle<Promise<Reply | null>, z.infer<typeof callInput>>;
/** Server, given by rpc and remoteData: pushes replies; false when the address is not theirs. */
export type Stream = Operation.Handle<Promise<boolean>, z.infer<typeof watchInput>>;

/** Turns values to text and back. Both sides of a transport must use the same one; JSON unset. */
export type Codec = { serialize(value: unknown): string; deserialize(text: string): unknown };
