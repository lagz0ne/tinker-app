import { capsule, data, operation, resource, tag } from "@tinker/core";
import type { Capsule, Operation, Resource, Tag } from "@tinker/core";
import { z } from "zod";

import { callInput, middleware, watchInput } from "~/components/protocol";
import type {
  Answer,
  Call,
  Entry,
  Fault,
  Middleware,
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
export const channel = tag<{ send(output: unknown): void; closed: AbortSignal }>({
  label: "rpc.channel",
});

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

type Config<C extends Contracts> = Job<C> & { readonly use?: readonly Middleware[] };

const reserved = ["answer", "stream", "fault"];
const name = "rpc"; // labels only: the wire address is the key

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
  readonly contracts: Contracts;
  readonly keys: readonly string[];
  readonly brand: object;
  readonly answer: unknown;
  readonly stream: unknown;
};

/** The config every definition's capsule has, as its hooks read it. */
type Read = {
  readonly remote: Tag.Presence<Remote>;
  readonly implement: Tag.Presence<Readonly<Record<string, unknown>>>;
  readonly use: readonly Middleware[];
};

type Event = Omit<Capsule.Events["run"], "config"> & { readonly config: Read };

/**
 * The steps every rpc capsule runs: check its config at start, send a key (`remote`), run it
 * here (`implement`), and serve the protocol's `answer` and `stream`.
 */
const steps = resource({
  label: "rpc.steps",
  target: "scope",
  depends: { chain: middleware },
  factory: ({ chain }) => {
    const faultOf = (
      def: Def,
      address: string,
      fault: Fault,
      payload: unknown,
      traceId: string | undefined,
    ): RpcFault =>
      Object.assign(new Error(`${address}: ${fault}${traceId ? ` (trace ${traceId})` : ""}`), {
        [brandKey]: def.brand,
        address,
        fault,
        payload,
        traceId,
      });

    /**
     * Pull side of a stream: `start` gets `push` first (a source may push at once), then the
     * outputs are read with for await. `end` runs when the reader leaves.
     */
    const pull = <T>(
      start: (push: (r: Reply) => void) => Promise<unknown>,
      parse: (v: unknown) => T,
      onFault: (r: Failed) => unknown,
      end?: () => void,
    ) => {
      const queue: Reply[] = [];
      let wake = () => {};
      let done = false;
      const ended = start((r) => (queue.push(r), wake())).finally(() => ((done = true), wake()));
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (;;) {
              const reply = queue.shift();
              if (reply?.ok) yield parse(reply.value);
              else if (reply) throw onFault(reply);
              else if (done) return void (await ended);
              else await new Promise<void>((r) => (wake = r));
            }
          } finally {
            end?.();
          }
        },
      };
    };

    /** Start: one job, `implement` or `remote`; with `implement`, a run for every key. */
    const check = (def: Def, config: Read, raise: (kind: string, payload: unknown) => never) => {
      if (config.remote.present === config.implement.present) {
        raise("MissingConfig", { label: name, key: "implement | remote" });
      }
      const implement = config.implement.present ? config.implement.value : {};
      const missing = config.implement.present
        ? def.keys.find((key) => !implement[key] || !chain.runOf(implement[key]))
        : undefined;
      if (missing) raise("MissingConfig", { label: name, key: `implement.${missing}` });
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

    /** remote: the key goes through `use`, then the protocol. A fault throws, branded. */
    const sendKey = (def: Def, event: Event, key: string) => {
      const { call: invocation, run, config, raise, log, obs } = event;
      const traceId = obs.span?.traceId;
      const contract = def.contracts[key]!;
      if (!config.remote.present) return raise("MissingConfig", { label: name, key: "remote" });
      const remote = config.remote.value;
      const input = inputOf(def, event, key);
      const faulted = (r: Failed) => {
        if (r.kind !== "refused") log.warn("rpc fault", { address: key, fault: r.kind });
        return faultOf(def, key, r.kind, r.payload, traceId);
      };

      return chain
        .runChain(run as never, config.use, key, input, {}, async (meta, tags) => {
          const bind = tags.length ? { tags } : {};
          const signal = invocation?.signal;
          if ((contract.mode ?? "reply") === "reply") {
            const ask = { input: { address: key, value: input, meta }, signal, ...bind };
            const reply = await run(remote.call, ask, sent);
            if (!reply.ok) throw faulted(reply);
            return contract.output.parse(reply.value);
          }

          if (!remote.watch) return raise("MissingConfig", { label: name, key: "remote.watch" });
          const watch = remote.watch;
          return pull(
            (push) =>
              Promise.resolve(
                run(
                  watch,
                  { input: { address: key, value: input, meta, push }, signal, ...bind },
                  sent,
                ),
              ),
            (v) => contract.output.parse(v),
            faulted,
          );
        })
        .then((out) => {
          // A client-side middleware said no.
          if (chain.isRefused(out)) throw faultOf(def, key, "refused", out.payload, traceId);
          return out;
        });
    };

    /** implement: the key runs here, through `use` and its entry, then the app's op. */
    const runHere = (def: Def, event: Event, key: string) => {
      const { call: invocation, run, config, raise, obs } = event;
      const traceId = obs.span?.traceId;
      const contract = def.contracts[key]!;
      const input = inputOf(def, event, key);
      if (!config.implement.present) {
        return raise("MissingConfig", { label: name, key: "implement" });
      }
      const entry = config.implement.value[key];
      const implementation = chain.runOf(entry) as Operation.Handle<unknown, unknown>;

      return chain
        .runChain(
          run as never,
          chain.chainOf(config.use, entry),
          key,
          input,
          {},
          async (_, tags) => {
            if ((contract.mode ?? "reply") === "reply") {
              // Its own layer, as on the server: a transaction ends with this run's result.
              const ask = { input, signal: event.signal, ...(tags.length ? { tags } : {}) };
              return contract.output.parse(await run(implementation, ask, work));
            }

            // A stream: the op sends into a queue; leaving the for-await closes the channel.
            const leave = new AbortController();
            invocation?.signal?.addEventListener("abort", () => leave.abort(), { once: true });
            return pull(
              (push) => {
                const send = (value: unknown) =>
                  push({ ok: true, value: contract.output.parse(value) });
                const out = channel({ send, closed: leave.signal });
                return Promise.resolve(run(implementation, { input, tags: [...tags, out] }, work));
              },
              (v) => v,
              (r) => faultOf(def, key, r.kind, r.payload, traceId),
              () => leave.abort(),
            );
          },
        )
        .then((out) => {
          if (chain.isRefused(out)) throw faultOf(def, key, "refused", out.payload, traceId);
          return out;
        });
    };

    /** A throw is `failed`, whatever it carries: its kind is never read. The cause stays here, whole. */
    const failedAt =
      ({ log, obs }: Event, address: string) =>
      (error: unknown): Reply => {
        obs.event("rpc.failed", { address });
        log.error("rpc call failed", {
          address,
          cause: String(error),
          stack: String(Object(error).stack ?? ""),
        });
        return { ok: false, kind: "failed", payload: {} };
      };

    /** A refusal is `refused`, with its payload; a value is checked against the output shape. */
    const answeredAs =
      (contract: Contract) =>
      (out: unknown): Reply =>
        chain.isRefused(out)
          ? { ok: false, kind: "refused", payload: out.payload }
          : { ok: true, value: contract.output.parse(out) };

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

      const parsed = def.contracts[asked.address]!.input.safeParse(asked.value);
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
      const implementation = chain.runOf(entry) as Operation.Handle<unknown, unknown>;
      const use = chain.chainOf(config.use, entry);
      // A bad output throws inside `answeredAs`: catch it too, so it is `failed` and not a crash.
      return chain
        .runChain(run as never, use, address, input, meta, (_, tags) =>
          // Its own layer (a call with a signal, ADR 0090): a session-target resource, such as
          // a transaction, ends with the implementation's result, not the request session's close.
          run(
            implementation,
            { input, signal: event.signal, ...(tags.length ? { tags } : {}) },
            work,
          ),
        )
        .then(answeredAs(def.contracts[address]!))
        .catch(failedAt(event, address));
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
      const implementation = chain.runOf(entry) as Operation.Handle<unknown, unknown>;
      const use = chain.chainOf(config.use, entry);
      const send = (value: unknown) => push({ ok: true, value: contract.output.parse(value) });
      const out = channel({ send, closed: left ?? new AbortController().signal });

      return chain
        .runChain(run as never, use, address, input, meta, (_, tags) =>
          run(implementation, { input, tags: [...tags, out] }, work),
        )
        .then(
          (end) => (chain.isRefused(end) && push(answeredAs(contract)(end)), true),
          (error) => (push(failedAt(event, address)(error)), true),
        );
    };

    return {
      faultOf,
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
 * - `implement`: a run goes through `use` and the key's entry, then the app's op, in this
 *   process (as tRPC createCaller). `api.answer` and `api.stream` serve the protocol.
 * - `remote`: a run goes through `use`, then the protocol's `call` or `watch`.
 * Values only: the protocol owns the codec.
 */
export function rpc<const C extends Contracts>(contracts: C) {
  const keys = Object.keys(contracts) as (keyof C & string)[];
  const taken = keys.find((key) => reserved.includes(key));
  if (taken) throw new Error(`${name}: "${taken}" is a reserved key`);
  const brand = {}; // this definition's own
  const fault = {
    /** True for a fault from a call of this definition, on this side. */
    is: (error: unknown): error is RpcFault<keyof C & string> => Object(error)[brandKey] === brand,
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

  const useKey = tag<readonly Middleware[]>({ label: `${name}.use`, default: [] });
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
  const def: Def = { contracts, keys, brand, answer, stream };
  const own = data<Steps | null>({ label: `${name}.steps`, initial: null });

  const configShape = { remote: remoteKey.optional, implement: implementKey.optional, use: useKey };
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
  return Object.assign(base, { fault, addresses: keys }) as unknown as Omit<typeof base, never> &
    Ops<C> & {
      readonly answer: Answer;
      readonly stream: Stream;
      readonly fault: typeof fault;
      readonly addresses: readonly string[];
      readonly contracts: C;
      (values: Config<C>): ReturnType<typeof base>;
    };
}
