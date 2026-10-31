import type {
  Options,
  Query,
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultError,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** One `query()` the fake saw: its params, how often `close()` ran, and whether its generator ended. */
export type FakeCall = {
  prompt: string;
  options: Options;
  closed: number;
  ended: boolean;
};

/** What a script gets: the call, its session id, and waits that end with an AbortError on abort. */
export type FakeKit = {
  call: FakeCall;
  session: string;
  signal: AbortSignal;
  hang: () => Promise<never>;
  wait: (gate: Promise<unknown>) => Promise<void>;
  /** Resolves (not rejects) on abort: for a stubborn SDK that goes on after it. */
  untilAbort: () => Promise<void>;
  /** True: the fake keeps yielding after the abort, as a stubborn SDK might. */
  ignoreAbort: boolean;
};

/** A scripted turn: yields real SDK message shapes, like obelisk's talk-fake.mjs. */
export type FakeScript = (kit: FakeKit) => AsyncGenerator<SDKMessage, void, undefined>;

export const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

export const init = (session: string): SDKMessage =>
  ({
    type: "system",
    subtype: "init",
    session_id: session,
    model: "claude-haiku-5-5",
    tools: ["WebSearch"],
    mcp_servers: [{ name: "talk", status: "connected" }],
    claude_code_version: "2.9.0",
    permissionMode: "dontAsk",
  }) satisfies Pick<
    SDKSystemMessage,
    | "type"
    | "subtype"
    | "session_id"
    | "model"
    | "tools"
    | "mcp_servers"
    | "claude_code_version"
    | "permissionMode"
  > as unknown as SDKMessage;

const streamEvent = (session: string, event: unknown): SDKMessage =>
  ({ type: "stream_event", event, parent_tool_use_id: null, session_id: session }) satisfies Pick<
    SDKPartialAssistantMessage,
    "type" | "parent_tool_use_id" | "session_id"
  > & { event: unknown } as unknown as SDKMessage;

export const usage = {
  input_tokens: 2,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 30,
  output_tokens: 8,
};

export const assistant = (session: string, id: string, content: unknown[]): SDKMessage =>
  ({
    type: "assistant",
    message: { id, role: "assistant", content, usage },
    parent_tool_use_id: null,
    session_id: session,
  }) satisfies Pick<SDKAssistantMessage, "type" | "parent_tool_use_id" | "session_id"> & {
    message: unknown;
  } as unknown as SDKMessage;

/** A streamed text reply in the real order: message_start, block start, two deltas, the whole message, stop. */
export function say(session: string, id: string, text: string): SDKMessage[] {
  const half = Math.ceil(text.length / 2);

  return [
    streamEvent(session, { type: "message_start", message: { id } }),
    streamEvent(session, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    streamEvent(session, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(0, half) },
    }),
    streamEvent(session, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(half) },
    }),
    assistant(session, id, [{ type: "text", text }]),
    streamEvent(session, { type: "content_block_stop", index: 0 }),
  ];
}

/** A streamed text reply cut into one-character deltas. */
export function spell(session: string, id: string, text: string): SDKMessage[] {
  const [start, open, , , whole, stop] = say(session, id, text);

  return [
    start!,
    open!,
    ...text.split("").map((char) =>
      streamEvent(session, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: char },
      }),
    ),
    whole!,
    stop!,
  ];
}

export const toolResult = (
  session: string,
  id: string,
  text: string,
  isError = false,
): SDKMessage =>
  ({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: [{ type: "text", text }],
          is_error: isError,
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: session,
  }) satisfies Pick<
    SDKUserMessage,
    "type" | "message" | "parent_tool_use_id" | "session_id"
  > as unknown as SDKMessage;

export const compact = (session: string, pre: number, post: number): SDKMessage =>
  ({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "manual", pre_tokens: pre, post_tokens: post },
    session_id: session,
  }) satisfies Pick<
    SDKCompactBoundaryMessage,
    "type" | "subtype" | "compact_metadata" | "session_id"
  > as unknown as SDKMessage;

export const success = (
  session: string,
  cost = 0.25,
  extra: Partial<Pick<SDKResultSuccess, "result" | "permission_denials" | "usage">> = {},
): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    session_id: session,
    total_cost_usd: cost,
    usage: usage as unknown as SDKResultSuccess["usage"],
    num_turns: 1,
    duration_ms: 1200,
    permission_denials: [],
    ...extra,
  }) satisfies Pick<
    SDKResultSuccess,
    | "type"
    | "subtype"
    | "is_error"
    | "result"
    | "session_id"
    | "total_cost_usd"
    | "usage"
    | "num_turns"
    | "duration_ms"
    | "permission_denials"
  > as unknown as SDKMessage;

export const failure = (
  session: string,
  subtype: SDKResultError["subtype"],
  errors: string[],
): SDKMessage =>
  ({
    type: "result",
    subtype,
    is_error: true,
    errors,
    session_id: session,
    total_cost_usd: 0,
    num_turns: 1,
    duration_ms: 10,
    permission_denials: [],
  }) satisfies Pick<
    SDKResultError,
    | "type"
    | "subtype"
    | "is_error"
    | "errors"
    | "session_id"
    | "total_cost_usd"
    | "num_turns"
    | "duration_ms"
    | "permission_denials"
  > as unknown as SDKMessage;

/** Claude Code's answer with no sign-in: a success result that is an error, then exit code 1. */
export async function* notLoggedIn({ session }: FakeKit) {
  yield init(session);
  yield {
    type: "result",
    subtype: "success",
    is_error: true,
    result: "Not logged in · Please run /login",
    session_id: session,
  } as unknown as SDKMessage;
  throw new Error("Claude Code process exited with code 1");
}

export async function* reply({ session }: FakeKit) {
  yield init(session);
  yield* say(session, "msg_1", "ok");
  yield success(session);
}

export async function* hangs({ session, hang }: FakeKit) {
  yield init(session);
  yield* say(session, "msg_1", "counting");
  await hang();
}

/**
 * The seam for `agentSdk`: `query` runs the next script (default: a short reply), honours
 * `options.abortController`, and records every params and close().
 */
export function fakeAgentSdk(...scripts: FakeScript[]) {
  const calls: FakeCall[] = [];
  const queue = [...scripts];
  const made: unknown[][] = [];

  const query = (params: { prompt: string; options: Options }): Query => {
    const call: FakeCall = {
      prompt: params.prompt,
      options: params.options,
      closed: 0,
      ended: false,
    };
    const controller = params.options.abortController ?? new AbortController();
    const signal = controller.signal;
    const script = queue.shift() ?? reply;
    const session = params.options.resume ?? `session-${calls.length + 1}`;

    calls.push(call);

    const kit: FakeKit = {
      call,
      session,
      signal,
      ignoreAbort: false,
      hang: () => kit.wait(new Promise(() => {})) as Promise<never>,
      untilAbort: () =>
        new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();

          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      wait: (gate) =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(abortError());

          signal.addEventListener("abort", () => reject(abortError()), { once: true });
          void gate.then(() => resolve());
        }),
    };

    async function* run() {
      try {
        for await (const message of script(kit)) {
          if (signal.aborted && !kit.ignoreAbort) throw abortError();

          yield message;
        }
      } finally {
        // A real process takes a moment to exit; a join that does not wait shows up here.
        await new Promise<void>((resolve) => setImmediate(resolve));

        call.ended = true;
      }
    }

    return Object.assign(run(), {
      close() {
        call.closed++;
        controller.abort();
      },
      interrupt: async () => controller.abort(),
    }) as unknown as Query;
  };

  return {
    calls,
    made,
    script: (...more: FakeScript[]) => queue.push(...more),
    sdk: { query } as unknown as typeof import("@anthropic-ai/claude-agent-sdk"),
    files: {
      mkdir: async (...args: unknown[]) => {
        made.push(args);
      },
    } as unknown as typeof import("node:fs/promises"),
  };
}
