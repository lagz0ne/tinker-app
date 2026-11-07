import { capsule, data, operation, resource, tag } from "@tinker/core";
import type { Capsule, Operation, Resource, Tag } from "@tinker/core";
import { z } from "zod";

import { bodyShape, callInput, lifecycle, watchInput } from "~/components/protocol";
import type {
  Answer,
  Body,
  BytesLimit,
  Call,
  Entry,
  Fault,
  Hooks,
  OnError,
  OnFinish,
  OnStart,
  OnSuccess,
  Reply,
  Stream,
  Watch,
} from "~/components/protocol";

/**
 * A key's contract: input and output shapes, no error list. A domain outcome (a todo that is gone)
 * is part of the output shape, as a union: the op returns it, the client reads it. No guessing.
 */
type Contract = {
  input: z.ZodType;
  output: z.ZodType;
  /** "reply" (default): one output. "stream": many outputs. */
  mode?: "reply" | "stream";
};

type Contracts = Readonly<Record<string, Contract>>;

type In<C extends Contract> = z.infer<C["input"]>;

type Out<C extends Contract> = C["mode"] extends "stream"
  ? AsyncIterable<z.infer<C["output"]>>
  : z.infer<C["output"]>;

type Ops<C extends Contracts> = {
  readonly [K in keyof C]: Operation.Handle<Promise<Out<C[K]>>, In<C[K]>>;
};

type Implement<C extends Contracts> = {
  readonly [K in keyof C]: Entry<
    Operation.Handle<
      C[K]["mode"] extends "stream"
        ? void | Promise<void>
        : z.infer<C[K]["output"]> | Promise<z.infer<C[K]["output"]>>,
      In<C[K]>
    >
  >;
};

/**
 * A stream key's implementation is a long op that depends on `channel`: it sends each output and
 * returns when done, or when `closed` aborts (the caller left). Not an async generator: its body
 * runs after the op run ended, when its depends are gone (Disposed). Not the run's own signal
 * either: an aborted run disposes its depends at once, so no cleanup could write (F32).
 */
export const channel = tag<{
  send(output: unknown, meta?: Record<string, string>): void;
  closed: AbortSignal;
}>({
  label: "rpc.channel",
});

const limitKey = Symbol("rpc.bytes");

/**
 * A field of a key's input that carries bytes, as a file input does: a Blob on the client, a body
 * read once on the server. The key then goes on its own POST beside the socket, with the rest of
 * its input as text; the server checks `max` and `types` before it reads one byte.
 *
 *   "talk.attach": {
 *     input: z.object({ name: z.string(), file: bytes({ max: 10 << 20 }) }),
 *     output: z.object({ id: z.string() }),
 *   }
 */
export const bytes = ({
  max,
  types = ["application/octet-stream"],
}: {
  max: number;
  types?: readonly string[];
}): z.ZodType<Body> & { readonly [limitKey]: BytesLimit } => {
  if (!Number.isSafeInteger(max) || max <= 0 || types.length === 0) {
    throw new TypeError("bytes: max is a positive whole number, and types lists one at least");
  }
  return Object.assign(bodyShape.clone(), { [limitKey]: { max, types } });
};

const sent = { role: "handler", explain: "Sends through the protocol" } as const;
const work = { role: "handler", explain: "Runs the implementation" } as const;
const held = { role: "state", explain: "The rpc steps of this root" } as const;

/** The job, picked by the config: run the keys here (`implement`), or send them (`remote`). */
type Job<C extends Contracts> =
  | { readonly implement: Implement<C>; readonly remote?: never }
  | {
      readonly remote: { readonly call: Call; readonly watch?: Watch };
      readonly implement?: never;
    };

type Config<C extends Contracts> = Job<C> & Hooks;

const reserved = ["answer", "stream", "fault"];

/**
 * The call's own fault, thrown on the calling side and told apart by its definition's brand:
 * `api.fault.is(error)`. Never a domain outcome; never a kind read off a free-form Error.
 */
const brandKey = Symbol("rpc.fault");

/** `traceId`: the trace of the call that faulted, so one id finds every log line on both sides (OTel). */
export type RpcFault<K extends string = string> = Error & {
  readonly address: K;
  readonly fault: Fault;
  readonly payload: unknown;
  readonly traceId: string | undefined;
};

type Remote = { readonly call: Call; readonly watch?: Watch };
type Failed = Extract<Reply, { ok: false }>;

/** One definition, as the steps read it: its contracts, its brand, its serving ops. */
type Def = {
  /** Labels only: the wire address is the key. */
  readonly name: string;
  readonly contracts: Contracts;
  readonly keys: readonly string[];
  /** The keys with a bytes field: the field's name and its limits. */
  readonly bytesOf: Readonly<Record<string, BytesLimit & { field: string }>>;
  readonly fault: {
    is(error: unknown): boolean;
    make(address: string, fault: Fault, payload: unknown, traceId: string | undefined): RpcFault;
  };
  readonly answer: unknown;
  readonly stream: unknown;
  /** One push taken on the calling side: an OTel process span, linked to the sender's span. */
  readonly receive: unknown;
};

/** The config every definition's capsule has, as its hooks read it. */
type Read = {
  readonly remote: Tag.Presence<Remote>;
  readonly implement: Tag.Presence<Readonly<Record<string, unknown>>>;
  readonly retry: Partial<Record<Fault, number>>;
  readonly onStart: readonly OnStart[];
  readonly onSuccess: readonly OnSuccess[];
  readonly onError: readonly OnError[];
  readonly onFinish: readonly OnFinish[];
};

type Event = Omit<Capsule.Events["run"], "config"> & { readonly config: Read };

/**
 * The steps every rpc capsule runs: check its config at start, send a key (`remote`), run it
 * here (`implement`), and serve the protocol's `answer` and `stream`.
 */
const steps = resource({
  label: "rpc.steps",
  target: "scope",
  depends: { flow: lifecycle },
  factory: ({ flow }) => {
    /** The capsule's own hooks, as one key's hooks read them. */
    const hooksIn = (config: Read): Hooks => ({
      retry: config.retry,
      onStart: config.onStart,
      onSuccess: config.onSuccess,
      onError: config.onError,
      onFinish: config.onFinish,
    });

    /** The fault kind of this definition's own fault; undefined for anything else (a shape). */
    const kindOf =
      (def: Def) =>
      (error: unknown): Fault | undefined =>
        def.fault.is(error) ? (error as RpcFault).fault : undefined;

    const faultOf = (
      def: Def,
      address: string,
      fault: Fault,
      payload: unknown,
      traceId: string | undefined,
    ): RpcFault => def.fault.make(address, fault, payload, traceId);

    /**
     * Pull side of a stream: `start` gets `push` first (a source may push at once), then the
     * outputs are read with for await. `end` runs when the reader leaves. `meta` is the meta of
     * the output just read (a push's `traceparent`), as a Response carries its headers.
     */
    const pull = <T>(
      start: (push: (r: Reply) => void) => Promise<unknown>,
      parse: (v: unknown) => T,
      onFault: (r: Failed) => unknown,
      end?: (reason?: unknown) => void,
    ) => {
      const queue: Reply[] = [];
      let wake = () => {};
      let done = false;
      let meta: Record<string, string> | undefined;
      let stopped = false;
      const ended = start((r) => (queue.push(r), wake())).finally(() => ((done = true), wake()));

      return {
        get meta() {
          return meta;
        },
        /** Leaves the stream from outside the loop, as a break does from inside. */
        stop(reason?: unknown) {
          stopped = true;
          void ended.catch(() => undefined); // a left stream's own end is no one's error
          end?.(reason);
          wake();
        },
        async *[Symbol.asyncIterator]() {
          try {
            for (;;) {
              if (stopped) return;
              const reply = queue.shift();
              if (reply?.ok) {
                meta = reply.meta;
                yield parse(reply.value);
              } else if (reply) throw onFault(reply);
              else if (done) return void (await ended);
              else await new Promise<void>((r) => (wake = r));
            }
          } finally {
            void ended.catch(() => undefined); // the reader may leave first: its end is no error
            end?.();
          }
        },
      };
    };

    /**
     * Client: a bytes key's input, as the protocol sends it: the value without its bytes field,
     * and the bytes as a Blob of a type the key takes (its first type when the Blob has another).
     */
    const split = (def: Def, address: string, input: unknown) => {
      const limit = def.bytesOf[address];
      if (!limit) return { address, value: input };

      const { [limit.field]: file, ...value } = input as Record<string, Body>;
      const media = file!.type.split(";")[0]!.trim().toLowerCase(); // "text/plain;charset=utf-8"
      const type = limit.types.includes(media) ? media : limit.types[0]!;
      const body = file!.type === type ? file! : new Blob([file as Blob], { type });

      return { address, value, body };
    };

    /** Server: the value with its bytes back in their field; a bytes key with no bytes is `invalid`. */
    const joined = (def: Def, asked: { address: string; value: unknown; body?: Body }) => {
      const limit = def.bytesOf[asked.address];
      if (!limit) return asked.value;
      return { ...Object(asked.value), [limit.field]: asked.body };
    };

    /** Start: one job, `implement` or `remote`; with `implement`, a run for every key. */
    const check = (def: Def, config: Read, raise: (kind: string, payload: unknown) => never) => {
      if (config.remote.present === config.implement.present) {
        raise("MissingConfig", { label: def.name, key: "implement | remote" });
      }
      const implement = config.implement.present ? config.implement.value : {};
      const missing = config.implement.present
        ? def.keys.find((key) => !implement[key] || !flow.runOf(implement[key]))
        : undefined;
      if (missing) raise("MissingConfig", { label: def.name, key: `implement.${missing}` });
    };

    /** The edge: bad input is this side's bug; it throws here, before anything runs or is sent. */
    const inputOf = (def: Def, { call: invocation, raise }: Event, key: string) => {
      const raw = invocation && "input" in invocation ? invocation.input : invocation?.rawInput;
      const input = def.contracts[key]!.input.safeParse(raw);
      if (!input.success) {
        return raise("DataValidationFailed", { address: key, issues: input.error.issues });
      }
      return input.data;
    };

    /** remote: the key goes through the lifecycle's hooks, then the protocol. A fault throws, branded. */
    const sendKey = (def: Def, event: Event, key: string) => {
      const { call: invocation, run, config, raise, log, obs } = event;
      const traceId = obs.span?.traceId;
      const contract = def.contracts[key]!;
      if (!config.remote.present) {
        return raise("MissingConfig", { label: def.name, key: "remote" });
      }
      const remote = config.remote.value;
      const input = inputOf(def, event, key);
      const reply = (contract.mode ?? "reply") === "reply";
      if (!reply && !remote.watch) {
        return raise("MissingConfig", { label: def.name, key: "remote.watch" });
      }
      const watch = remote.watch;
      const faulted = (r: Failed) => {
        if (r.kind !== "refused") log.warn(`${def.name} fault`, { address: key, fault: r.kind });
        return faultOf(def, key, r.kind, r.payload, traceId);
      };

      return flow
        .runHooks(
          run as never,
          flow.hooksOf(hooksIn(config), undefined),
          key,
          input,
          {},
          async (meta, tags) => {
            const bind = tags.length ? { tags } : {};
            const signal = invocation?.signal;
            if (reply) {
              const ask = { input: { ...split(def, key, input), meta }, signal, ...bind };
              const answer = await run(remote.call, ask, sent);
              if (!answer.ok) throw faulted(answer);
              return answer.value;
            }

            // The reader leaves (a break, or `stop()`): the watch ends, as the server's channel does.
            const leave = new AbortController();
            const until = signal ? AbortSignal.any([signal, leave.signal]) : leave.signal;
            return pull(
              (push) =>
                Promise.resolve(
                  run(
                    watch!,
                    { input: { address: key, value: input, meta, push }, signal: until, ...bind },
                    sent,
                  ),
                ),
              (v) => contract.output.parse(v),
              faulted,
              (reason) => leave.abort(reason),
            );
          },
          {
            reply,
            signal: invocation?.signal,
            shape: contract.output,
            kind: kindOf(def),
          },
        )
        .then((out) => {
          // A client-side hook said no.
          if (flow.isRefused(out)) throw faultOf(def, key, "refused", out.payload, traceId);
          return out;
        });
    };

    /** implement: the key runs here, through the capsule's hooks and its entry, then the app's op. */
    const runHere = (def: Def, event: Event, key: string) => {
      const { call: invocation, run, config, raise, obs } = event;
      const traceId = obs.span?.traceId;
      const contract = def.contracts[key]!;
      const input = inputOf(def, event, key);
      if (!config.implement.present) {
        return raise("MissingConfig", { label: def.name, key: "implement" });
      }
      const entry = config.implement.value[key];
      const implementation = flow.runOf(entry) as Operation.Handle<unknown, unknown>;
      const reply = (contract.mode ?? "reply") === "reply";

      return flow
        .runHooks(
          run as never,
          flow.hooksOf(hooksIn(config), entry),
          key,
          input,
          {},
          async (_, tags) => {
            if (reply) {
              // Its own layer, as on the server: a transaction ends with this run's result.
              const ask = { input, signal: event.signal, ...(tags.length ? { tags } : {}) };
              return run(implementation, ask, work);
            }

            // A stream: the op sends into a queue; leaving the for-await closes the channel.
            const leave = new AbortController();
            invocation?.signal?.addEventListener("abort", () => leave.abort(), { once: true });
            return pull(
              (push) => {
                const send = (value: unknown, meta?: Record<string, string>) =>
                  push({
                    ok: true,
                    value: contract.output.parse(value),
                    ...(meta ? { meta } : {}),
                  });
                const out = channel({ send, closed: leave.signal });
                return Promise.resolve(run(implementation, { input, tags: [...tags, out] }, work));
              },
              (v) => v,
              (r) => faultOf(def, key, r.kind, r.payload, traceId),
              () => leave.abort(),
            );
          },
          {
            reply,
            signal: event.signal,
            shape: contract.output,
            kind: "failed",
          },
        )
        .then((out) => {
          if (flow.isRefused(out)) throw faultOf(def, key, "refused", out.payload, traceId);
          return out;
        });
    };

    /** A throw is `failed`, whatever it carries: its kind is never read. The cause stays here, whole. */
    const failedAt =
      (def: Def, { log, obs }: Event, address: string) =>
      (error: unknown): Reply => {
        obs.event(`${def.name}.failed`, { address });
        log.error(`${def.name} call failed`, {
          address,
          cause: String(error),
          stack: String(Object(error).stack ?? ""),
        });
        return { ok: false, kind: "failed", payload: {} };
      };

    /** A refusal is `refused`, with its payload; a value goes out as it is (runHooks parsed it). */
    const answeredAs = (out: unknown): Reply =>
      flow.isRefused(out)
        ? { ok: false, kind: "refused", payload: out.payload }
        : { ok: true, value: out };

    /** Input that does not fit: `invalid`, as the answer or as the stream's one push. */
    const invalid = (answering: boolean, push: (r: Reply) => void) => {
      const bad: Reply = { ok: false, kind: "invalid", payload: {} };
      return answering ? Promise.resolve(bad) : Promise.resolve(push(bad)).then(() => true);
    };

    /** answer and stream: the protocol asks; the key runs here; failures become the envelope. */
    const serve = (def: Def, event: Event) => {
      const { op, config } = event;
      const { input, rawInput } = event.call ?? {};
      const asked = (input ?? rawInput) as z.infer<typeof watchInput>;
      const answering = op === def.answer;
      if (!config.implement.present || !Object.hasOwn(def.contracts, asked.address)) {
        return Promise.resolve(answering ? null : false);
      }

      const parsed = def.contracts[asked.address]!.input.safeParse(joined(def, asked));
      const here = answering ? answerHere : streamHere;
      return parsed.success ? here(def, event, asked, parsed.data) : invalid(answering, asked.push);
    };

    /** answer: one output, as the envelope. */
    const answerHere = (
      def: Def,
      event: Event,
      { address, meta }: z.infer<typeof callInput>,
      input: unknown,
    ) => {
      // A key answers only in its own mode: a stream key never runs from a call.
      if (def.contracts[address]!.mode === "stream") return Promise.resolve(null);

      const { run, config } = event;
      const entry = config.implement.present ? config.implement.value[address] : undefined;
      const implementation = flow.runOf(entry) as Operation.Handle<unknown, unknown>;
      const contract = def.contracts[address]!;
      // A bad output throws out of `runHooks`: catch it too, so it is `failed` and not a crash.
      return flow
        .runHooks(
          run as never,
          flow.hooksOf(hooksIn(config), entry),
          address,
          input,
          meta,
          (_, tags) =>
            // Its own layer (a call with a signal, ADR 0090): a session-target resource, such as
            // a transaction, ends with the implementation's result, not the request session's close.
            Promise.resolve(
              run(
                implementation,
                { input, signal: event.signal, ...(tags.length ? { tags } : {}) },
                work,
              ),
            ),
          {
            reply: true,
            signal: event.signal,
            shape: contract.output,
            kind: "failed",
          },
        )
        .then(answeredAs)
        .catch(failedAt(def, event, address));
    };

    /** stream: each output pushed, until the op returns or the caller leaves (`left`). */
    const streamHere = (
      def: Def,
      event: Event,
      { address, meta, push, left }: z.infer<typeof watchInput>,
      input: unknown,
    ) => {
      const { run, config } = event;
      const contract = def.contracts[address]!;
      // A key answers only in its own mode: a reply key never runs from a stream, a GET that a
      // link on another site can send with the user's cookies.
      if (contract.mode !== "stream") return Promise.resolve(false);

      const entry = config.implement.present ? config.implement.value[address] : undefined;
      const implementation = flow.runOf(entry) as Operation.Handle<unknown, unknown>;
      const send = (value: unknown, meta?: Record<string, string>) =>
        push({ ok: true, value: contract.output.parse(value), ...(meta ? { meta } : {}) });
      const out = channel({ send, closed: left ?? event.signal ?? new AbortController().signal });

      return flow
        .runHooks(
          run as never,
          flow.hooksOf(hooksIn(config), entry),
          address,
          input,
          meta,
          (_, tags) => Promise.resolve(run(implementation, { input, tags: [...tags, out] }, work)),
          { reply: false, kind: "failed" },
        )
        .then(
          (end) => (flow.isRefused(end) && push(answeredAs(end)), true),
          (error) => (push(failedAt(def, event, address)(error)), true),
        );
    };

    return {
      split,
      joined,
      faultOf,
      kindOf,
      hooksIn,
      pull,
      check,
      inputOf,
      sendKey,
      runHere,
      failedAt,
      answeredAs,
      invalid,
      serve,
      answerHere,
      streamHere,
    };
  },
});

type Steps = typeof steps extends Resource.Handle<infer T> ? Awaited<T> : never;

/**
 * One definition gives one capsule, as remoteData. `api["todo.add"]` is the same handle on both sides:
 * - `implement`: a run goes through the capsule's hooks and the key's entry, then the app's op,
 *   in this process (as tRPC createCaller). `api.answer` and `api.stream` serve the protocol.
 * - `remote`: a run goes through the capsule's hooks, then the protocol's `call` or `watch`.
 * Values only: the protocol owns the codec.
 */
export function rpc<const C extends Contracts>(
  contracts: C,
  /** `label` names its spans and logs (remoteData passes its own); the wire address is the key. */
  { label: name = "rpc" }: { readonly label?: string } = {},
) {
  const keys = Object.keys(contracts) as (keyof C & string)[];
  const taken = keys.find((key) => reserved.includes(key));
  if (taken) throw new Error(`${name}: "${taken}" is a reserved key`);
  const bytesOf = Object.fromEntries(
    keys.flatMap((key) => {
      const shape = Object(Object(contracts[key]!.input).shape) as Record<string, unknown>;
      const fields = Object.keys(shape).filter((field) => Object(shape[field])[limitKey]);
      if (fields.length > 1 || (fields.length && contracts[key]!.mode === "stream")) {
        throw new Error(
          `${name}: "${key}" takes bytes in one field at most, and only as a reply key`,
        );
      }
      const field = fields[0];
      return field ? [[key, { field, ...Object(shape[field])[limitKey] }]] : [];
    }),
  ) as Record<string, BytesLimit & { field: string }>;
  const uploads: Record<string, BytesLimit> = Object.fromEntries(
    Object.entries(bytesOf).map(([key, { max, types }]) => [key, { max, types }]),
  );
  const brand = {}; // this definition's own
  const fault = {
    /** True for a fault from a call of this definition, on this side. */
    is: (error: unknown): error is RpcFault<keyof C & string> => Object(error)[brandKey] === brand,
    /** A fault of this definition, made on this side (the transport failed, a value did not fit). */
    make: (address: string, kind: Fault, payload: unknown, traceId: string | undefined): RpcFault =>
      Object.assign(new Error(`${address}: ${kind}${traceId ? ` (trace ${traceId})` : ""}`), {
        [brandKey]: brand,
        address,
        fault: kind,
        payload,
        traceId,
      }),
  };

  const ops = Object.fromEntries(
    keys.map((key) => [
      key,
      operation({
        label: key,
        input: contracts[key]!.input,
        run: (): never => {
          throw new Error(`${key}: no rpc capsule`);
        },
      }),
    ]),
  ) as unknown as Ops<C>;
  const keyOf = new Map<unknown, string>(keys.map((key) => [ops[key], key]));

  const retryKey = tag<Partial<Record<Fault, number>>>({ label: `${name}.retry`, default: {} });
  const onStartKey = tag<readonly OnStart[]>({ label: `${name}.onStart`, default: [] });
  const onSuccessKey = tag<readonly OnSuccess[]>({ label: `${name}.onSuccess`, default: [] });
  const onErrorKey = tag<readonly OnError[]>({ label: `${name}.onError`, default: [] });
  const onFinishKey = tag<readonly OnFinish[]>({ label: `${name}.onFinish`, default: [] });
  const remoteKey = tag<Remote>({ label: `${name}.remote` });
  const implementKey = tag<Implement<C>>({ label: `${name}.implement` });
  const answer = operation({
    label: `${name}.answer`,
    input: callInput,
    run: (): Promise<Reply | null> => {
      throw new Error(`${name} does not serve here`);
    },
  });
  const stream = operation({
    label: `${name}.stream`,
    input: watchInput,
    run: (): Promise<boolean> => {
      throw new Error(`${name} does not serve here`);
    },
  });
  /**
   * One push taken by a stream reader: an OTel process span. A push that carries the sender's
   * span (`meta.traceparent`) records it as a link, since Core spans have no links of their own.
   */
  const receive = operation({
    label: `${name}.receive`,
    input: z.object({ key: z.string(), meta: z.record(z.string(), z.string()).optional() }),
    run: (_, { input, obs }) => {
      if (obs.span) {
        Object.assign(obs.span.attributes, {
          "messaging.operation.type": "process",
          "messaging.destination.name": input.key,
        });
      }
      const link = input.meta?.traceparent;
      if (link) obs.event("link", { traceparent: link });
      return obs.span?.traceId;
    },
  });
  const def: Def = { name, contracts, keys, bytesOf, fault, answer, stream, receive };
  const own = data<Steps | null>({ label: `${name}.steps`, initial: null });

  const configShape = {
    remote: remoteKey.optional,
    implement: implementKey.optional,
    retry: retryKey,
    onStart: onStartKey,
    onSuccess: onSuccessKey,
    onError: onErrorKey,
    onFinish: onFinishKey,
  };
  const base = capsule({
    label: name,
    config: configShape,
    exports: {
      ...(ops as Readonly<Record<string, Operation.Handle<any, any>>>),
      answer: answer as Answer,
      stream: stream as Stream,
    },
    hooks: {
      async start({ config, load, next, raise }) {
        const s = await load(steps, held);
        s.check(def, config as Read, raise as never);
        load(own, held).set(s);
        return next();
      },
      run(event) {
        const key = keyOf.get(event.op);
        const serving = event.op === answer || event.op === stream;
        if (key === undefined && !serving) return event.next();
        const s = event.load(own, held).get()!;
        if (key === undefined) return s.serve(def, event as unknown as Event);
        const job = event.config.remote.present ? s.sendKey : s.runHere;

        return job(def, event as unknown as Event, key);
      },
    },
  });

  /** One capsule; its call takes a union (Core config is flat: this cast is the gap, F28). */
  return Object.assign(base, { fault, receive, addresses: keys, uploads }) as unknown as Omit<
    typeof base,
    never
  > &
    Ops<C> & {
      readonly answer: Answer;
      readonly stream: Stream;
      /** A stream reader's process span for one push: `run(api.receive, { input: { key, meta } })`. */
      readonly receive: typeof receive;
      readonly fault: typeof fault;
      readonly addresses: readonly string[];
      /** The keys that take bytes, with their limits: the server's POST route reads them. */
      readonly uploads: Readonly<Record<string, BytesLimit>>;
      readonly contracts: C;
      (values: Config<C>): ReturnType<typeof base>;
    };
}
