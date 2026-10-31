import type {
  Options,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { resource } from "@tinker/core";

import { agentFiles, agentSdk } from "./modules.server";
import { agentConfigDir, agentCredentials, agentMaxRunning, agentPath } from "./settings";

/** What the app sets per turn; the component fixes every other option. */
export type TalkOptions = Pick<
  Options,
  | "model"
  | "systemPrompt"
  | "tools"
  | "allowedTools"
  | "disallowedTools"
  | "mcpServers"
  | "maxTurns"
  | "effort"
  | "cwd"
  | "resume"
>;

/** One turn: one `query()` with a string prompt; `onEvent` sees its stream until the result settles. */
export type Turn = { prompt: string; options: TalkOptions; onEvent?: (event: TalkEvent) => void };

/** The stream of one turn, mapped 1:1 from the SDK messages. */
export type TalkEvent =
  | { type: "waiting" }
  | {
      type: "init";
      sessionId: string;
      model: string;
      tools: string[];
      mcpServers: { name: string; status: string }[];
      claudeCodeVersion: string;
      permissionMode: string;
    }
  | { type: "text-start"; messageId: string }
  | { type: "text"; messageId: string; delta: string }
  | { type: "text-end"; messageId: string }
  /** Assistant text that was not already streamed. */
  | { type: "text-whole"; messageId: string; text: string }
  | { type: "tool-start"; id: string; name: string; input: unknown }
  | { type: "tool-end"; id: string; isError: boolean; text: string }
  /** Per assistant message: input + cache read + cache write + output, what the next call sends again. */
  | { type: "usage"; messageId: string; contextTokens: number; usage: unknown }
  | { type: "compact"; preTokens: number; postTokens: number }
  | { type: "session-lost" };

/** How a turn ended. `costUsd` is the SDK's running total for the session; the app takes the rise. */
export type TurnResult =
  | {
      status: "done";
      sessionId: string;
      costUsd: number;
      usage: unknown;
      numTurns: number;
      durationMs: number;
      denials: unknown[];
    }
  | {
      status: "failed";
      error: "not-signed-in" | "max-turns" | "claude" | "listener";
      message: string;
      sessionId?: string;
    }
  | { status: "stopped"; sessionId?: string }
  | { status: "closed"; sessionId?: string }
  | { status: "busy" };

/** Quiet ping turns that resume one session every `everyMs` until `untilMs` on the scope clock. */
export type WarmPlan = {
  options: TalkOptions & { resume: string };
  prompt: string;
  everyMs: number;
  untilMs: number;
  onPing?: (result: TurnResult) => void;
};

/** How a warm plan ended, with the pings that were done. */
export type WarmResult = {
  status: "ended" | "cancelled" | "replaced" | "stopped" | "closed" | "failed";
  pings: number;
  message?: string;
};

/** The scope's agent talks; result and done promises never reject. */
export type AgentTalk = {
  run(talk: string, turn: Turn): { result: Promise<TurnResult> };
  stop(talk: string): void;
  warm(talk: string, plan: WarmPlan): { done: Promise<WarmResult> };
};

type Played = { result?: TurnResult; sessionId?: string; lost?: boolean };

/** One turn's listener: the first throw is kept and aborts its controller. */
type Listener = {
  onEvent: ((event: TalkEvent) => void) | undefined;
  controller: AbortController;
  failure?: { error: unknown };
};

/** A place in the cap and in the talk's line of queries; `leave` gives both back. */
type Ticket = {
  talk: string;
  queued: boolean;
  granted: Promise<boolean>;
  before: Promise<void> | undefined;
  mine: PromiseWithResolvers<void>;
};

type Plan = { stop: AbortController; status?: WarmResult["status"] };

/** What one query has read so far. */
type Stream = {
  listener: Listener;
  streamed: Set<string>;
  messageId: string;
  texting: boolean;
  /** Redacted text held back while it may be the start of the credential. */
  pending: string;
  tools: number;
  measured: Set<string>;
  sessionId?: string;
  done?: TurnResult;
  ended?: { text: string; maxTurns: boolean };
};

const signedOut =
  /not logged in|please run \/login|invalid api key|authentication_error|oauth token|401/i;

const lostSession = /no conversation found|session.*not found/i;

/**
 * A scope owns every agent run, wait, and keep-warm timer. Close aborts them all through
 * `closing` and joins them in `defer`, so no Claude process outlives its scope.
 */
export const agentTalk = resource({
  label: "agentTalk",
  target: "scope",
  depends: {
    sdk: agentSdk,
    files: agentFiles,
    signIn: agentCredentials.optional,
    configDir: agentConfigDir.required,
    path: agentPath,
    max: agentMaxRunning,
  },
  factory: async (
    { sdk, files, signIn, configDir, path, max },
    { closing, clock, defer, log },
  ): Promise<AgentTalk> => {
    const credentials = signIn.present ? signIn.value : undefined;
    const secret =
      credentials && ("oauthToken" in credentials ? credentials.oauthToken : credentials.apiKey);
    const tmp = `${configDir.replace(/\/+$/, "")}/tmp`;
    const env = {
      PATH: path,
      HOME: configDir,
      CLAUDE_CONFIG_DIR: configDir,
      TMPDIR: tmp,
      LANG: "C.UTF-8",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      ...(credentials && "oauthToken" in credentials
        ? { CLAUDE_CODE_OAUTH_TOKEN: credentials.oauthToken }
        : {}),
      ...(credentials && "apiKey" in credentials ? { ANTHROPIC_API_KEY: credentials.apiKey } : {}),
    };
    const notSignedIn = "Not signed in: agentCredentials is unbound";
    const ended = new AbortController();
    const stopping = AbortSignal.any([closing, ended.signal]);

    await files.mkdir(tmp, { recursive: true });

    const runs = new Map<string, { stop: AbortController }>();
    const plans = new Map<string, Plan>();
    const tails = new Map<string, Promise<void>>();
    const waiters: {
      granted: PromiseWithResolvers<boolean>;
      signal: AbortSignal;
      leave: () => void;
    }[] = [];
    const inflight = new Set<Promise<unknown>>();
    let active = 0;

    const owned = {
      redact(text: string) {
        return secret ? text.replaceAll(secret, "[redacted]") : text;
      },
      message(error: unknown) {
        return owned.redact(error instanceof Error ? error.message : String(error));
      },
      track<T>(work: Promise<T>) {
        inflight.add(work);
        void work.finally(() => inflight.delete(work));

        return work;
      },
      /** Gives the event to the turn's listener; a throw aborts that listener's controller. */
      emit(listener: Listener, event: TalkEvent) {
        if (!listener.onEvent || listener.failure || listener.controller.signal.aborted) return;

        try {
          listener.onEvent(event);
        } catch (error) {
          listener.failure = { error };
          listener.controller.abort(error);
        }
      },
      /**
       * Takes a slot under the cap (now, or in FIFO order) and a place after the talk's previous
       * query, so one talk never has two queries at once. An abort leaves the queue.
       */
      enter(talk: string, signal: AbortSignal): Ticket {
        const before = tails.get(talk);
        const mine = Promise.withResolvers<void>();

        tails.set(talk, mine.promise);

        if (signal.aborted) {
          return { talk, queued: false, granted: Promise.resolve(false), before, mine };
        }

        if (active < max) {
          active++;

          return { talk, queued: false, granted: Promise.resolve(true), before, mine };
        }

        const granted = Promise.withResolvers<boolean>();
        const leave = () => {
          const index = waiters.findIndex((waiter) => waiter.granted === granted);

          if (index >= 0) waiters.splice(index, 1);
          granted.resolve(false);
        };

        waiters.push({ granted, signal, leave });
        signal.addEventListener("abort", leave, { once: true });

        return { talk, queued: true, granted: granted.promise, before, mine };
      },
      /** Gives back the slot (waking the next waiter) and the talk's place. */
      leave(ticket: Ticket, granted: boolean) {
        if (granted) {
          active--;

          const next = waiters.shift();
          if (next) {
            next.signal.removeEventListener("abort", next.leave);
            active++;
            next.granted.resolve(true);
          }
        }

        ticket.mine.resolve();
        if (tails.get(ticket.talk) === ticket.mine.promise) tails.delete(ticket.talk);
      },
      /** One query: maps its messages to events and settles only after its loop ended and close() ran. */
      async play(
        prompt: string,
        options: TalkOptions,
        onEvent: ((event: TalkEvent) => void) | undefined,
        signal: AbortSignal,
      ): Promise<Played> {
        const controller = new AbortController();
        const stream: Stream = {
          listener: { onEvent, controller },
          streamed: new Set(),
          messageId: "",
          texting: false,
          pending: "",
          tools: 0,
          measured: new Set(),
        };
        const abort = () => controller.abort(signal.reason);
        let thrown: { error: unknown } | undefined;
        let query: Query | undefined;

        signal.addEventListener("abort", abort, { once: true });

        try {
          query = sdk.query({
            prompt,
            options: {
              ...options,
              permissionMode: "dontAsk",
              settingSources: [],
              strictMcpConfig: true,
              persistSession: true,
              includePartialMessages: true,
              settings: { disableClaudeAiConnectors: true },
              abortController: controller,
              env,
            },
          });

          for await (const message of query) {
            if (controller.signal.aborted) break;

            owned.read(stream, message);
          }
        } catch (error) {
          // Claude Code exits with code 1 after a failed result; the result already says why.
          thrown = { error };
        } finally {
          query?.close();
          signal.removeEventListener("abort", abort);
        }

        const fallback = thrown ? owned.message(thrown.error) : "Claude ended without a result";

        return owned.settle(stream, signal, fallback);
      },
      read(stream: Stream, message: SDKMessage) {
        switch (message.type) {
          case "system":
            return owned.system(stream, message);
          case "stream_event":
            return owned.streamEvent(stream, message.event);
          case "assistant":
            return owned.assistant(stream, message);
          case "user":
            return owned.toolResults(stream, message);
          case "result":
            return owned.result(stream, message);
        }
      },
      system(stream: Stream, message: Extract<SDKMessage, { type: "system" }>) {
        if (message.subtype === "init") {
          stream.sessionId = message.session_id;
          owned.emit(stream.listener, {
            type: "init",
            sessionId: message.session_id,
            model: message.model,
            tools: message.tools,
            mcpServers: message.mcp_servers.map(({ name, status }) => ({ name, status })),
            claudeCodeVersion: message.claude_code_version,
            permissionMode: message.permissionMode,
          });
        } else if (message.subtype === "compact_boundary") {
          owned.emit(stream.listener, {
            type: "compact",
            preTokens: message.compact_metadata.pre_tokens,
            postTokens: message.compact_metadata.post_tokens ?? 0,
          });
        }
      },
      streamEvent(stream: Stream, event: SDKPartialAssistantMessage["event"]) {
        if (event.type === "message_start") {
          stream.messageId = event.message.id;
        } else if (event.type === "content_block_start") {
          if (event.content_block.type !== "text") return;

          stream.texting = true;
          stream.streamed.add(stream.messageId);
          owned.emit(stream.listener, { type: "text-start", messageId: stream.messageId });
        } else owned.streamText(stream, event);
      },
      streamText(stream: Stream, event: SDKPartialAssistantMessage["event"]) {
        if (!stream.texting) return;

        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          owned.carry(stream, event.delta.text, false);
        } else if (event.type === "content_block_stop") {
          owned.carry(stream, "", true);
          stream.texting = false;
          owned.emit(stream.listener, { type: "text-end", messageId: stream.messageId });
        }
      },
      /** Emits redacted text, holding back a tail that may be the start of a split credential. */
      carry(stream: Stream, text: string, flush: boolean) {
        const redacted = owned.redact(stream.pending + text);
        const cut = redacted.length - (flush ? 0 : owned.held(redacted));
        const delta = redacted.slice(0, cut);

        stream.pending = redacted.slice(cut);

        if (delta) {
          owned.emit(stream.listener, { type: "text", messageId: stream.messageId, delta });
        }
      },
      /** The longest end of `text` that starts the credential. */
      held(text: string) {
        if (!secret) return 0;

        for (let size = Math.min(secret.length - 1, text.length); size > 0; size--) {
          if (text.endsWith(secret.slice(0, size))) return size;
        }

        return 0;
      },
      /** Every string inside a value, redacted; the shape stays. */
      scrub(value: unknown): unknown {
        if (!secret) return value;

        if (typeof value === "string") return owned.redact(value);

        if (Array.isArray(value)) return value.map((item) => owned.scrub(item));

        if (value && typeof value === "object") {
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, owned.scrub(item)]),
          );
        }

        return value;
      },
      assistant(stream: Stream, message: SDKAssistantMessage) {
        const id = message.message.id;
        const usage = message.message.usage;

        for (const block of message.message.content) owned.block(stream, id, block);

        if (!usage || stream.measured.has(id)) return;

        stream.measured.add(id);

        const contextTokens = [
          usage.input_tokens,
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens,
          usage.output_tokens,
        ].reduce<number>((sum, tokens) => sum + (tokens ?? 0), 0);

        owned.emit(stream.listener, {
          type: "usage",
          messageId: id,
          contextTokens,
          usage: owned.scrub(usage),
        });
      },
      /** Assistant text not already streamed, and each tool call. */
      block(stream: Stream, id: string, block: SDKAssistantMessage["message"]["content"][number]) {
        if (block.type === "text" && block.text.trim() && !stream.streamed.has(id)) {
          owned.emit(stream.listener, {
            type: "text-whole",
            messageId: id,
            text: owned.redact(block.text),
          });
        } else if (block.type === "tool_use") {
          stream.tools++;
          owned.emit(stream.listener, {
            type: "tool-start",
            id: block.id,
            name: block.name,
            input: owned.scrub(block.input),
          });
        }
      },
      toolResults(stream: Stream, message: Extract<SDKMessage, { type: "user" }>) {
        if (!Array.isArray(message.message.content)) return;

        for (const block of message.message.content) {
          if (block.type !== "tool_result") continue;

          const text =
            typeof block.content === "string"
              ? block.content
              : (block.content ?? [])
                  .map((part) => (part.type === "text" ? part.text : ""))
                  .join(" ");

          owned.emit(stream.listener, {
            type: "tool-end",
            id: block.tool_use_id,
            isError: !!block.is_error,
            text: owned.redact(text),
          });
        }
      },
      result(stream: Stream, message: SDKResultMessage) {
        stream.sessionId = message.session_id || stream.sessionId;

        if (
          message.subtype === "success" &&
          !message.is_error &&
          !owned.signedOutReply(stream, message.result)
        ) {
          stream.done = {
            status: "done",
            sessionId: message.session_id,
            costUsd: message.total_cost_usd,
            usage: owned.scrub(message.usage),
            numTurns: message.num_turns,
            durationMs: message.duration_ms,
            denials: owned.scrub(message.permission_denials) as unknown[],
          };
        } else {
          stream.ended = {
            text:
              (message.subtype === "success" ? message.result : message.errors.join("; ")) ||
              message.subtype,
            maxTurns: message.subtype === "error_max_turns",
          };
        }
      },
      /** Claude Code's not-signed-in answer can come as a success; a turn that ran a tool is real work. */
      signedOutReply(stream: Stream, text: string) {
        return stream.tools === 0 && signedOut.test(text);
      },
      /** The query's outcome: a listener throw, a result, an abort, then an error text. */
      settle(stream: Stream, signal: AbortSignal, fallback: string): Played {
        const session = stream.sessionId ? { sessionId: stream.sessionId } : {};
        const failure = stream.listener.failure;

        if (failure) {
          return {
            result: {
              status: "failed",
              error: "listener",
              message: owned.message(failure.error),
              ...session,
            },
          };
        }

        if (stream.done) return { result: stream.done };

        if (signal.aborted) return session;

        const text = owned.redact(stream.ended?.text ?? fallback);

        return owned.failed(text, !!stream.ended?.maxTurns, session);
      },
      failed(text: string, maxTurns: boolean, session: { sessionId?: string }): Played {
        const error = maxTurns ? "max-turns" : signedOut.test(text) ? "not-signed-in" : "claude";

        return {
          result: { status: "failed", error, message: text, ...session },
          lost: error === "claude" && lostSession.test(text),
          ...session,
        };
      },
      async turn(talk: string, entry: { stop: AbortController }, turn: Turn): Promise<TurnResult> {
        const listener: Listener = { onEvent: turn.onEvent, controller: new AbortController() };
        const signal = AbortSignal.any([stopping, entry.stop.signal, listener.controller.signal]);
        const ticket = owned.enter(talk, signal);
        let played: Played | undefined;
        let granted = false;

        if (ticket.queued) owned.emit(listener, { type: "waiting" });

        try {
          granted = await ticket.granted;

          await ticket.before;

          if (granted && !signal.aborted) played = await owned.converse(turn, listener, signal);
        } finally {
          owned.leave(ticket, granted);
        }

        const result = owned.outcome(entry, listener, played);

        if (result.status === "failed") {
          log.warn("agentTalk.failed", { talk, error: result.error, message: result.message });
        }

        return result;
      },
      /** The turn's query, and once more without `resume` when its session is lost. */
      async converse(turn: Turn, listener: Listener, signal: AbortSignal): Promise<Played> {
        const played = await owned.play(turn.prompt, turn.options, turn.onEvent, signal);

        if (!played.lost || !turn.options.resume) return played;

        owned.emit(listener, { type: "session-lost" });

        if (signal.aborted) return played.sessionId ? { sessionId: played.sessionId } : {};

        const { resume: _lost, ...fresh } = turn.options;

        return owned.play(turn.prompt, fresh, turn.onEvent, signal);
      },
      outcome(
        entry: { stop: AbortController },
        listener: Listener,
        played: Played | undefined,
      ): TurnResult {
        if (listener.failure) {
          return {
            status: "failed",
            error: "listener",
            message: owned.message(listener.failure.error),
          };
        }

        if (played?.result) return played.result;

        const session = played?.sessionId ? { sessionId: played.sessionId } : {};

        const status = entry.stop.signal.aborted && !stopping.aborted ? "stopped" : "closed";

        return { status, ...session };
      },
      /** One quiet ping in the cap and the talk's line; undefined when the plan ended first. */
      async ping(
        talk: string,
        plan: WarmPlan,
        signal: AbortSignal,
      ): Promise<TurnResult | undefined> {
        const ticket = owned.enter(talk, signal);
        let granted = false;

        try {
          granted = await ticket.granted;

          await ticket.before;

          if (!granted || signal.aborted) return undefined;

          if (!secret) return { status: "failed", error: "not-signed-in", message: notSignedIn };

          return (await owned.play(plan.prompt, plan.options, undefined, signal)).result;
        } finally {
          owned.leave(ticket, granted);
        }
      },
      endPlan(talk: string, status: WarmResult["status"]) {
        const plan = plans.get(talk);
        if (!plan) return;

        plan.status ??= status;
        plans.delete(talk);
        plan.stop.abort();
      },
      async keep(talk: string, entry: Plan, plan: WarmPlan): Promise<WarmResult> {
        const signal = AbortSignal.any([stopping, entry.stop.signal]);
        const start = clock.currentTimeMillis();
        const count = { pings: 0 };

        for (let fire = 1; ; fire++) {
          try {
            await clock.sleep(
              Math.max(0, start + plan.everyMs * fire - clock.currentTimeMillis()),
              signal,
            );
          } catch {
            return { status: entry.status ?? "closed", pings: count.pings };
          }

          if (clock.currentTimeMillis() >= plan.untilMs) {
            return { status: "ended", pings: count.pings };
          }

          if (runs.has(talk)) continue;

          const ended = await owned.fire(talk, entry, plan, signal, count);

          if (ended) return ended;

          while (start + plan.everyMs * (fire + 1) <= clock.currentTimeMillis()) fire++;
        }
      },
      /** One fire of a plan: a ping, then `onPing`; a result only when the plan ends here. */
      async fire(
        talk: string,
        entry: Plan,
        plan: WarmPlan,
        signal: AbortSignal,
        count: { pings: number },
      ): Promise<WarmResult | undefined> {
        const result = await owned.ping(talk, plan, signal);

        if (signal.aborted || !result) {
          return { status: entry.status ?? "closed", pings: count.pings };
        }

        if (result.status !== "done") {
          const message = result.status === "failed" ? result.message : result.status;

          log.warn("agentTalk.pingFailed", { talk, message });

          return { status: "failed", pings: count.pings, message };
        }

        count.pings++;

        try {
          plan.onPing?.(result);
        } catch (error) {
          return { status: "failed", pings: count.pings, message: owned.message(error) };
        }

        return undefined;
      },
      run(talk: string, turn: Turn): { result: Promise<TurnResult> } {
        if (stopping.aborted) return { result: Promise.resolve({ status: "closed" }) };

        if (runs.has(talk)) return { result: Promise.resolve({ status: "busy" }) };

        if (!secret) {
          log.warn("agentTalk.failed", { talk, error: "not-signed-in", message: notSignedIn });

          return {
            result: Promise.resolve({
              status: "failed",
              error: "not-signed-in",
              message: notSignedIn,
            }),
          };
        }

        const entry = { stop: new AbortController() };

        runs.set(talk, entry);
        owned.endPlan(talk, "cancelled");

        const result = owned
          .turn(talk, entry, turn)
          .catch((error): TurnResult => ({
            status: "failed",
            error: "claude",
            message: owned.message(error),
          }))
          .finally(() => {
            if (runs.get(talk) === entry) runs.delete(talk);
          });

        return { result: owned.track(result) };
      },
      stop(talk: string) {
        runs.get(talk)?.stop.abort();
        owned.endPlan(talk, "stopped");
      },
      warm(talk: string, plan: WarmPlan): { done: Promise<WarmResult> } {
        if (stopping.aborted) return { done: Promise.resolve({ status: "closed", pings: 0 }) };

        if (!(Number.isFinite(plan.everyMs) && plan.everyMs > 0 && Number.isFinite(plan.untilMs))) {
          const message = "warm needs a finite everyMs above 0 and a finite untilMs";

          return { done: Promise.resolve({ status: "failed", pings: 0, message }) };
        }

        owned.endPlan(talk, "replaced");

        const entry: Plan = { stop: new AbortController() };

        plans.set(talk, entry);

        const done = owned
          .keep(talk, entry, plan)
          .catch((error): WarmResult => ({
            status: "failed",
            pings: 0,
            message: owned.message(error),
          }))
          .finally(() => {
            if (plans.get(talk) === entry) plans.delete(talk);
          });

        return { done: owned.track(done) };
      },
    };

    // Close aborts through `closing`; a release has no closing, so `ended` aborts the same work.
    defer(async () => {
      ended.abort();
      await Promise.all(inflight);
    });

    return owned;
  },
});
