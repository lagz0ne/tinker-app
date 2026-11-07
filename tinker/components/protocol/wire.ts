import type { Operation } from "@tinker/core";
import { z } from "zod";

// The shapes each layer gives the next (ADR 0048 words):
//   transport  moves text: sse, memory
//   protocol   gives text meaning: the codec and the reply envelope, shared by rpc and remoteData
//   rpc, remoteData deal in values only
// `meta`: string pairs beside the body (headers on SSE). Lowercase: HTTP header names have no case.

const meta = z.record(z.string().regex(/^[a-z0-9-]+$/), z.string());
/**
 * On a server, `left` aborts when the caller goes. It is data, not the run's signal: Core
 * disposes an aborted run's depends at once, so a stream could not clean up (F32). The server
 * run ends by itself once it sees `left`; then the transport closes the request session.
 */
const left = z.custom<AbortSignal>((v) => v instanceof AbortSignal).optional();

// ---- transport: text
export const sendInput = z.object({ address: z.string(), text: z.string(), meta });

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

export const callInput = z.object({ address: z.string(), value: z.unknown(), meta });

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
};

/** Server, given by rpc and remoteData: a reply, or null when the address is not theirs. */
export type Answer = Operation.Handle<Promise<Reply | null>, z.infer<typeof callInput>>;
/** Server, given by rpc and remoteData: pushes replies; false when the address is not theirs. */
export type Stream = Operation.Handle<Promise<boolean>, z.infer<typeof watchInput>>;

/**
 * How a stream's pushes travel: the protocol's choice, never the caller's. As HTTP delta
 * encoding (RFC 3229), the client asks with a header (`a-im: text-delta`) and the server
 * answers in kind. The delta is on the value's TEXT, so it works with any codec:
 *   whole  each push carries the whole value (the default)
 *   delta  each push carries only the changed text span, against the last push of that stream
 */
export type Pushes = "whole" | "delta";
/**
 * How many transport streams the watches use: also the protocol's choice.
 *   each  one stream per watched address (the default)
 *   one   the watches started in the same tick share one stream, as HTTP/2 or graphql-ws
 *         carry many streams on one connection. The server sends the pushes made in the
 *         same tick as ONE frame, so the keys one write changed arrive together.
 */
export type Streams = "each" | "one";
/** The changed span of a text: drop `cut` chars at `at`, put `add` there. From "" it is the whole text. */
export type Delta = { at: number; cut: number; add: string };

/** Turns values to text and back. Both sides of a transport must use the same one; JSON unset. */
export type Codec = { serialize(value: unknown): string; deserialize(text: string): unknown };
