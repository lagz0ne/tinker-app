import { resource } from "@tinker/core";
import type { Operation, Tag } from "@tinker/core";
import { z } from "zod";

import type { Fault } from "./wire";

// The lifecycle: what happens around one run of a key, on either side (`onStart`, `onSuccess`,
// `onError`, `onFinish`), and how many times a faulted call may run again (`retry`). Words from
// oRPC, and `retry` from TanStack Query: a hook is a plain operation, written where it is used,
// and given to one capsule as config. No shared declaration, no sides: the client capsule and
// the service capsule run the same hook lists, each its own. What crosses the wire (an error
// kind) is protocol, declared on the definition.
//
// `onStart` may refuse (`refuse(payload)`), add meta for the rest of the call, bind tags, or
// leave a context for the later hooks. `onError` may refuse, or answer a value: recovery. Only
// the work runs again on a named fault; the hooks run once per call.
//
// One hook, both capsules:
//   meta     string pairs beside the body. The client sends what reaches the work; a service
//            sees what came in. An `onStart` answer adds pairs for the rest.
//   tags     bound for the rest: the backend call on a client, the implementation on a service.
//   context  the `onStart` answers, for the later hooks: a start time, a request id.

export type Meta = Record<string, string>;
export type Tags = Tag.Binding<unknown>[];
export type Context = Readonly<Record<string, unknown>>;

/** How one call ended, as `onFinish` reads it. */
export type Outcome =
  | { kind: "output"; output: unknown }
  | { kind: "refused"; payload: unknown }
  | { kind: "error"; error: unknown };

/**
 * A hook that says no returns `refuse(payload)`: a value, not a throw. The call stops and
 * answers the `refused` fault with that payload (like HTTP 401/403).
 */
const refusedBrand = Symbol("refused");
export type Refused = { readonly [refusedBrand]: true; readonly payload: unknown };

const refusable = z.custom<(payload: unknown) => Refused>((v) => typeof v === "function");

const outcomeOf = z.custom<Outcome>((v) =>
  ["output", "refused", "error"].includes(String(Object(v).kind)),
);

/** One input schema per hook kind: the same fields, and the one thing that hook may answer. */
export const hook = {
  start: z.object({
    key: z.string(),
    input: z.unknown(),
    meta: z.record(z.string(), z.string()),
    context: z.record(z.string(), z.unknown()),
    refuse: refusable,
  }),
  success: z.object({
    key: z.string(),
    input: z.unknown(),
    meta: z.record(z.string(), z.string()),
    context: z.record(z.string(), z.unknown()),
    output: z.unknown(),
  }),
  error: z.object({
    key: z.string(),
    input: z.unknown(),
    meta: z.record(z.string(), z.string()),
    context: z.record(z.string(), z.unknown()),
    error: z.unknown(),
    refuse: refusable,
  }),
  finish: z.object({
    key: z.string(),
    input: z.unknown(),
    meta: z.record(z.string(), z.string()),
    context: z.record(z.string(), z.unknown()),
    outcome: outcomeOf,
  }),
};

export type OnStart = Operation.Handle<Promise<unknown> | unknown, z.infer<typeof hook.start>>;
export type OnSuccess = Operation.Handle<Promise<unknown> | unknown, z.infer<typeof hook.success>>;
export type OnError = Operation.Handle<Promise<unknown> | unknown, z.infer<typeof hook.error>>;
export type OnFinish = Operation.Handle<Promise<unknown> | unknown, z.infer<typeof hook.finish>>;

/** What a capsule's config holds: the lists run in order; `retry` names fault kinds and counts. */
export type Hooks = {
  readonly retry?: Partial<Record<Fault, number>>;
  readonly onStart?: readonly OnStart[];
  readonly onSuccess?: readonly OnSuccess[];
  readonly onError?: readonly OnError[];
  readonly onFinish?: readonly OnFinish[];
};

/**
 * A key's entry in a service's `implement`: a plain operation inherits the capsule's hooks;
 * `{ run, ...hooks }` adds after them; `{ run, inherit: false, ...hooks }` drops them.
 */
export type Entry<Op> = Op | (Hooks & { readonly run: Op; readonly inherit?: boolean });

type Own = Hooks & { readonly run: unknown; readonly inherit?: boolean };

const why = { role: "handler", explain: "A lifecycle hook" } as const;
type Run = (op: any, call: any, m: typeof why) => Promise<unknown>;

/** How a call ended inside `runHooks`, before `onFinish` reads it. */
type Settled =
  | { readonly kind: "output"; readonly output: unknown }
  | { readonly kind: "refused"; readonly value: Refused }
  | { readonly kind: "error"; readonly error: unknown };

/**
 * What `runHooks` needs beside the hooks: whether this call is a reply or a stream, the tags
 * bound so far, the call's signal (no run again after it aborts), the contract's output shape
 * (to check a value with), and which fault kind an error is (only a named kind runs again): one kind, or a
 * reader for the kinds a fault carries.
 */
export type RunOptions = {
  readonly reply?: boolean;
  readonly tags?: Tags;
  readonly signal?: AbortSignal;
  readonly shape?: { readonly parse: (value: unknown) => unknown };
  readonly kind?: Fault | ((error: unknown) => Fault | undefined);
};

/** One call's fixed parts, as its steps read them. */
type Frame = {
  readonly run: Run;
  readonly key: string;
  readonly input: unknown;
  readonly reply: boolean;
  readonly signal?: AbortSignal;
  readonly shape?: RunOptions["shape"];
  readonly kind?: RunOptions["kind"];
  readonly last: (meta: Meta, tags: Tags) => Promise<unknown>;
};

/** One call's moving parts: what a hook may add, and what the later ones read. */
type State = {
  meta: Meta;
  tags: Tags;
  context: Context;
  output: unknown;
};

/**
 * The lifecycle's tools, shared by rpc and remoteData: `refuse` and `isRefused` for a "no",
 * `runOf` and `hooksOf` for an `implement` entry, `runHooks` to run one call's hooks and work.
 */
export const lifecycle = resource({
  label: "protocol.lifecycle",
  target: "scope",
  factory: () => {
    const refuse = (payload: unknown): Refused => ({ [refusedBrand]: true, payload });

    const isRefused = (value: unknown): value is Refused =>
      typeof value === "object" && value !== null && refusedBrand in value;

    // An operation handle has a `run` too, but its `run` is a function; an entry's `run` is a handle.
    const isOwn = (entry: unknown): entry is Own => typeof Object(entry).run === "object";
    const runOf = (entry: unknown): unknown => (isOwn(entry) ? entry.run : entry);

    /** One list: the capsule's, then the entry's. */
    const both = <T>(capsule: readonly T[] | undefined, entry: readonly T[] | undefined) => [
      ...(capsule ?? []),
      ...(entry ?? []),
    ];

    /** The four lists of one key: the capsule's, then the entry's. */
    const listsOf = (capsule: Hooks, entry: Own): Hooks => ({
      onStart: both(capsule.onStart, entry.onStart),
      onSuccess: both(capsule.onSuccess, entry.onSuccess),
      onError: both(capsule.onError, entry.onError),
      onFinish: both(capsule.onFinish, entry.onFinish),
    });

    /** The hooks of one key: the capsule's, then the entry's; or, `inherit: false`, its own. */
    const hooksOf = (capsule: Hooks, entry: unknown): Hooks => {
      if (!isOwn(entry)) return capsule;
      if (entry.inherit === false) return { ...listsOf({}, entry), retry: entry.retry ?? {} };

      return { ...listsOf(capsule, entry), retry: entry.retry ?? capsule.retry };
    };

    /** One hook's run: its call, and the tags bound so far. */
    const hookOf = (
      frame: Frame,
      one: OnStart | OnSuccess | OnError | OnFinish,
      state: State,
      input: object,
    ) =>
      Promise.resolve(
        frame.run(one, { input, ...(state.tags.length ? { tags: state.tags } : {}) }, why),
      );

    /** The meta, tags and context an `onStart` answer adds, for the hooks and work after it. */
    const moreOf = (state: State, said: unknown) => {
      const more = said as { meta?: Meta; tags?: Tags; context?: Context };
      state.meta = { ...state.meta, ...more.meta };
      state.context = { ...state.context, ...more.context };
      state.tags = [...state.tags, ...(more.tags ?? [])];
    };

    /** `onStart`: each may refuse (stop here), or add to the state for the rest of the call. */
    const startOf = async (
      frame: Frame,
      hooks: Hooks,
      state: State,
    ): Promise<Refused | undefined> => {
      for (const one of hooks.onStart ?? []) {
        const said = await hookOf(frame, one, state, {
          meta: state.meta,
          context: state.context,
          refuse,
        });

        if (said === undefined) continue;
        if (isRefused(said)) return said;
        moreOf(state, said);
      }

      return undefined;
    };

    /** How many more runs a fault may have: `runs` is 0 when `retry` does not name its kind. */
    const againOf = (frame: Frame, fault: unknown, left: Partial<Record<Fault, number>>) => {
      const said = typeof frame.kind === "function" ? frame.kind(fault) : frame.kind;
      const kind = frame.reply ? said : undefined;

      return { kind, runs: kind ? (left[kind] ?? 0) : 0 };
    };

    /** The work, and only the work, runs again: at most `retry[kind]` more runs after a fault. */
    const workOf = async (frame: Frame, hooks: Hooks, state: State) => {
      const left: Partial<Record<Fault, number>> = { ...hooks.retry };

      for (;;) {
        try {
          state.output = await frame.last(state.meta, state.tags);

          return;
        } catch (fault) {
          const { kind, runs } = againOf(frame, fault, left);
          if (!kind || runs < 1 || frame.signal?.aborted) throw fault;
          left[kind] = runs - 1;
        }
      }
    };

    /** `onSuccess`, a reply only: its answer is the new output; undefined keeps it. */
    const successOf = async (frame: Frame, hooks: Hooks, state: State) => {
      for (const one of hooks.onSuccess ?? []) {
        const said = await hookOf(frame, one, state, {
          output: state.output,
          context: state.context,
        });

        if (said !== undefined) state.output = said;
      }
    };

    /** `onError`: each gets the error so far; a value recovers, a throw is the next one's error. */
    const errorsOf = async (
      frame: Frame,
      hooks: Hooks,
      state: State,
      first: unknown,
    ): Promise<Settled> => {
      let error = first;

      for (const one of hooks.onError ?? []) {
        let said: unknown;
        try {
          said = await hookOf(frame, one, state, { error, context: state.context, refuse });
        } catch (thrown) {
          error = thrown;
          continue;
        }

        if (said === undefined) continue;
        if (isRefused(said)) return { kind: "refused", value: said };
        // A stream has no one value to answer: recovery there is a bug, and says so.
        if (!frame.reply) throw new TypeError("onError cannot recover a stream");

        return { kind: "output", output: said };
      }

      return { kind: "error", error };
    };

    /** Steps 1 to 3: the hooks before the work, the work, then the success hooks. */
    const onceOf = async (frame: Frame, hooks: Hooks, state: State): Promise<Settled> => {
      try {
        const refused = await startOf(frame, hooks, state);
        if (refused) return { kind: "refused", value: refused };

        await workOf(frame, hooks, state);
        if (frame.reply) await successOf(frame, hooks, state);

        return { kind: "output", output: state.output };
      } catch (error) {
        return errorsOf(frame, hooks, state, error);
      }
    };

    /** The output shape checks a value a hook gave, as it checks the work's own. */
    const shapeOf = (frame: Frame, settled: Settled): Settled => {
      if (settled.kind !== "output" || !frame.reply || !frame.shape) return settled;

      try {
        return { kind: "output", output: frame.shape.parse(settled.output) };
      } catch (error) {
        return { kind: "error", error };
      }
    };

    /** Steps 1 to 4, as one outcome: `onFinish` reads it, whoever threw. */
    const settleOf = async (frame: Frame, hooks: Hooks, state: State): Promise<Settled> => {
      try {
        return shapeOf(frame, await onceOf(frame, hooks, state));
      } catch (error) {
        return { kind: "error", error };
      }
    };

    /** How one call ended, as `onFinish` reads it. */
    const outcomeOf = (settled: Settled): Outcome =>
      settled.kind === "output"
        ? { kind: "output", output: settled.output }
        : settled.kind === "refused"
          ? { kind: "refused", payload: settled.value.payload }
          : { kind: "error", error: settled.error };

    /** What the call answers: the output, the `Refused` value, or the throw that still stands. */
    const endOf = (settled: Settled): unknown => {
      if (settled.kind === "refused") return settled.value;
      if (settled.kind === "error") throw settled.error;

      return settled.output;
    };

    /**
     * Runs one call: `onStart`, the work (`last`) with retry, `onSuccess`, then `onError` for
     * what threw, then `onFinish` always. Answers the output, or the `Refused` value; or throws
     * what still stands. No hook calls another: a list runs in order, so no `next`.
     */
    const runHooks = async (
      run: Run,
      hooks: Hooks,
      key: string,
      input: unknown,
      meta: Meta,
      last: (meta: Meta, tags: Tags) => Promise<unknown>,
      options: RunOptions = {},
    ): Promise<unknown> => {
      const frame: Frame = {
        run,
        key,
        input,
        reply: options.reply ?? true,
        signal: options.signal,
        shape: options.shape,
        kind: options.kind,
        last,
      };
      const state: State = { meta, tags: options.tags ?? [], context: {}, output: undefined };

      const settled = await settleOf(frame, hooks, state);
      const outcome = outcomeOf(settled);
      // Always, with the outcome: its answer is ignored and its throw is thrown, as `finally`.
      for (const one of hooks.onFinish ?? []) {
        await hookOf(frame, one, state, { outcome, context: state.context });
      }

      return endOf(settled);
    };

    return {
      refuse,
      isRefused,
      isOwn,
      runOf,
      hooksOf,
      runHooks,
      // The steps of one call, each one small function: how a list, the work and a fault are run.
      parts: {
        both,
        listsOf,
        hookOf,
        moreOf,
        startOf,
        againOf,
        workOf,
        successOf,
        errorsOf,
        onceOf,
        shapeOf,
        settleOf,
        outcomeOf,
        endOf,
      },
    };
  },
});
