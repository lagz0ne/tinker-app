import { capsule, data, operation, parse, resource, tag } from "@tinker/core";
import type { Capsule, Data, Operation, Resource, Scope, Tag } from "@tinker/core";
import { z } from "zod";

import { callInput, middleware, protocol, watchInput } from "~/components/protocol";
import type { Answer, Call, Fault, Middleware, Reply, Stream, Watch } from "~/components/protocol";

type Cells = Readonly<Record<string, Data.Cell<any>>>;

/** The job, picked by the config: serve the cells here, or fill them from a backend. */
type Job =
  | { readonly serve: true; readonly fill?: Fill; readonly read?: never }
  | { readonly read: { readonly call: Call; readonly watch: Watch }; readonly serve?: never };

type Config = Job & { readonly use?: readonly Middleware[] };

/**
 * A keyed definition's first value for one parameter, per key: an op the server runs in a call
 * tagged with the parameter (`by(p)`), when a client asks for a parameter no write has given yet.
 * With no fill, the key's initial value goes out.
 */
type Fill = Readonly<Record<string, Operation.Handle<unknown, void>>>;

const meta = { role: "state", explain: "Remote data of this root" } as const;
const brandKey = Symbol("remoteData.fault");
const send = { role: "handler", explain: "Sends through the protocol" } as const;
const got = { role: "handler", explain: "Applies one push" } as const;
const sending = { role: "handler", explain: "Sends one write to its watchers" } as const;
const name = "remoteData"; // labels only: the wire address is the key
const reserved = ["answer", "stream", "drop", "fault", "faults"];

/** `traceId`: the trace of the read or push that faulted (OTel), to find its log lines. */
export type RemoteFault = Error & {
  readonly address: string;
  readonly fault: Fault;
  readonly payload: unknown;
  readonly traceId: string | undefined;
};

/** What a serving root keeps: each cell's root controller, and who watches each key. */
type Served = {
  roots: Map<string, Scope.DataController<unknown>>;
  copies: Map<string, Scope.DataController<unknown>>;
  /** By slot: the key, or the key and its parameter (`slot`). */
  watchers: Map<string, Map<(r: Reply) => void, () => void>>;
  /** A keyed definition: each watched slot's last value, held while a client watches it. */
  held: Map<string, unknown>;
};

/** A keyed definition's parameter: its config values, by config key (F12). */
type Param = Readonly<Record<string, unknown>>;

/** A reading root's values for one parameter, shared by every session that names it. */
type Entry = {
  refs: number;
  values: Map<string, unknown>;
  faults: Faults;
  listeners: Set<() => void>;
  stop: AbortController;
};

/** Where a reader puts what arrives: the root's own cells (no entry), or one parameter's entry. */
type Store = { readonly entry: Entry | null; readonly load: StartEvent["load"] };

type Faults = Readonly<Record<string, RemoteFault>>;
type Read = { readonly call: Call; readonly watch: Watch };

/** One definition, as the steps read it: its cells, its brand, its own units. */
type Def = {
  readonly cells: Cells;
  readonly made: Cells;
  readonly keys: readonly string[];
  readonly brand: object;
  readonly state: Data.Cell<Served | null>;
  readonly faults: Data.Cell<Faults>;
  readonly answer: unknown;
  /** A keyed definition's config (F12): one tag per key, made by the definition; null when not keyed. */
  readonly by: Readonly<Record<string, Tag.Handle<unknown>>> | null;
  /** The parameter in the caller's own layer: every config tag's value there, or null. */
  readonly paramOf: Resource.Handle<Param | null>;
  readonly getting: Operation.Handle<
    Promise<{ value: unknown; traceId: string | undefined }>,
    { key: string; go: () => Promise<unknown> }
  >;
  readonly receive: Operation.Handle<
    void,
    { key: string; meta?: Record<string, string>; apply: (traceId: string | undefined) => void }
  >;
};

/** The config every definition's capsule has, as its hooks read it. */
type Shape = {
  readonly serve: Tag.Presence<true>;
  readonly fill: Tag.Presence<Fill>;
  readonly read: Tag.Presence<Read>;
  readonly use: readonly Middleware[];
};

type StartEvent = Omit<Capsule.Events["start"], "config"> & { readonly config: Shape };
type RunEvent = Omit<Capsule.Events["run"], "config"> & { readonly config: Shape };

/**
 * The steps every remoteData capsule runs: serve its cells (`serve`), or fill them from a
 * backend (`read`), and answer the protocol's `answer` and `stream`.
 */
const steps = resource({
  label: "remoteData.steps",
  target: "scope",
  depends: { chain: middleware },
  factory: ({ chain }) => {
    const faultOf = (
      def: Def,
      address: string,
      fault: Fault,
      payload: unknown,
      traceId: string | undefined,
    ): RemoteFault =>
      Object.assign(new Error(`${address}: ${fault}${traceId ? ` (trace ${traceId})` : ""}`), {
        [brandKey]: def.brand,
        address,
        fault,
        payload,
        traceId,
      });

    const isFault = (def: Def, error: unknown): error is RemoteFault =>
      Object(error)[brandKey] === def.brand;

    /** A value that arrives: checked by the cell's own parse, when it has one. */
    const fits = (
      def: Def,
      key: string,
      value: unknown,
    ): { ok: true; value: unknown } | { ok: false; why: string } => {
      const check = def.cells[key]!.parse;
      if (!check) return { ok: true, value };
      try {
        return { ok: true, value: parse(check, value) };
      } catch (error) {
        return { ok: false, why: String(Object(error).kind ?? error) };
      }
    };

    /** Serve: the app writes the cells; this root holds them. */
    const serveStart = (def: Def, { load, next }: StartEvent) => {
      const roots = new Map(def.keys.map((key) => [key, load(def.cells[key]!, meta)] as const));
      const copies = new Map(def.keys.map((key) => [key, load(def.made[key]!, meta)] as const));
      for (const key of def.keys) copies.get(key)!.set(roots.get(key)!.get());
      load(def.state, meta).set({ roots, copies, watchers: new Map(), held: new Map() });
      return next();
    };

    /**
     * One parameter as text: its entries in key order, so equal values name one place. A served
     * key's place is the key, or the key and this text.
     */
    const named = (param: Param) =>
      JSON.stringify(
        Object.keys(param)
          .sort()
          .map((key) => [key, param[key]]),
      );

    /** A store's faults now: its entry's, or the root's cell. */
    const faultsIn = (def: Def, store: Store): Faults =>
      store.entry ? store.entry.faults : store.load(def.faults, meta).get();

    /** A reading root's own steps, for one start: they share its config, signal and log. */
    const reader = (
      def: Def,
      event: StartEvent,
      { call, watch }: Read,
      store: Store,
      param: Param | null,
      signal: AbortSignal,
    ) => {
      const { config, run, clock, log } = event;

      /** A key's last fault, or none: a new object per change, never mutated. */
      const mark = (key: string, error: RemoteFault | null) => {
        if (signal.aborted) return; // the scope is closing: nothing to show
        const now = faultsIn(def, store);
        if (!error && !Object.hasOwn(now, key)) return;
        const next: Record<string, RemoteFault> = { ...now };
        if (error) next[key] = error;
        else delete next[key];

        if (store.entry) {
          store.entry.faults = next;
          store.entry.listeners.forEach((listener) => listener());
        } else store.load(def.faults, meta).set(next);
      };

      /**
       * A value that does not fit the cell's parse is a fault, not a quiet skip: reading the key
       * throws `invalid` (side "client") until a good value arrives. The log says why.
       */
      const set = (key: string, value: unknown, traceId?: string) => {
        const checked = fits(def, key, value);
        if (!checked.ok) {
          log.error("remoteData value refused", { address: key, why: checked.why });
          return mark(key, faultOf(def, key, "invalid", { side: "client" }, traceId));
        }
        if (store.entry) {
          store.entry.values.set(key, checked.value);
          store.entry.listeners.forEach((listener) => listener());
        } else store.load(def.made[key]!, meta).set(checked.value);
        mark(key, null);
      };

      const caught = (key: string) => (error: unknown) =>
        mark(key, isFault(def, error) ? error : faultOf(def, key, "link", {}, undefined));

      const through = (
        key: string,
        ask: string,
        last: (meta: Record<string, string>) => Promise<unknown>,
      ) =>
        chain.runChain(
          run as never,
          config.use,
          key,
          param === null ? { op: ask } : { op: ask, param },
          {},
          (m) => last(m),
        );

      const once = (key: string) =>
        through(key, "get", async (m) => {
          const asked = { input: { address: key, value: param, meta: m }, signal };
          const reply = await run(call, asked, send);
          if (!reply.ok) throw faultOf(def, key, reply.kind, reply.payload, undefined);
          return reply.value;
        }).then((out) => {
          if (chain.isRefused(out)) throw faultOf(def, key, "refused", out.payload, undefined);
          return out;
        });

      const read = (key: string) => {
        const go = () => once(key);
        return run(def.getting, { input: { key, go }, signal }, send).then(
          (r) => set(key, r.value, r.traceId),
          caught(key),
        );
      };

      /**
       * One watch of a key, until it ends. A stream that ends is not a fault: the catch-up read
       * says if the server is there. A stream that cannot open is one: the key shows it (link, or
       * the fault it threw). One receive per push, at once, in arrival order: Core starts a run's
       * body when it is called, so the keys of one frame are all set before anything else runs.
       */
      const watchOnce = (key: string) => {
        const push = (r: Reply) => {
          const apply = (traceId: string | undefined) =>
            r.ok
              ? set(key, r.value, traceId)
              : mark(key, faultOf(def, key, r.kind, r.payload, traceId));
          const pushed = r.ok ? r.meta : undefined;
          return Promise.resolve(
            run(def.receive, { input: { key, meta: pushed, apply } }, got),
          ).catch((error) => {
            if (signal.aborted) return;
            log.error("remoteData receive failed", { address: key, cause: String(error) });
          });
        };
        return Promise.resolve(
          through(key, "watch", (m) =>
            run(watch, { input: { address: key, value: param, meta: m, push }, signal }, send),
          ),
        ).then(
          (out) =>
            chain.isRefused(out) ? faultOf(def, key, "refused", out.payload, undefined) : null,
          (error: unknown) =>
            isFault(def, error) ? error : faultOf(def, key, "link", {}, undefined),
        );
      };

      /** Keeps a key fresh: watch, catch up after a drop, and back off while it is faulted. */
      const loop = async (key: string) => {
        for (let round = 0, wait = 50; !signal.aborted; round++) {
          if (round > 0) await read(key); // catch up after a drop
          const ended = await watchOnce(key);
          if (ended) mark(key, ended);
          if (signal.aborted) break;

          // Back off while the key is faulted (as EventSource retry); 50 ms after a good round.
          wait = Object.hasOwn(faultsIn(def, store), key) ? Math.min(wait * 2, 5000) : 50;
          await clock.sleep(wait, signal).catch(() => undefined);
        }
      };

      return { mark, set, caught, through, once, read, watchOnce, loop };
    };

    /** Read: fill every cell from the backend, then keep it fresh. */
    const readStart = async (def: Def, event: StartEvent) => {
      const { config, raise, next, load, signal } = event;
      if (!config.read.present) return raise("MissingConfig", { label: name, key: "read" });
      // A keyed definition reads nothing at the root: each session that names a parameter does.
      if (def.by) {
        reading.set(def, { event, read: config.read.value, entries: new Map(), root: null });
        // Bound at the root: the root reads that parameter, as an unkeyed definition reads.
        const param = await load(def.paramOf, meta);
        if (param !== null) {
          reading.get(def)!.root = named(param);
          join(def, param, null);
        }
        return next();
      }
      const store: Store = { entry: null, load };
      const keys = reader(def, event, config.read.value, store, null, signal);
      // A fault on the first read does not fail start: the cell keeps its initial value, and
      // `board.faults` shows the fault.
      for (const key of def.keys) await keys.read(key);
      await next();

      for (const key of def.keys) void keys.loop(key);
    };

    /** A keyed reading root: its start context, and one entry per parameter some session names. */
    const reading = new Map<
      Def,
      { event: StartEvent; read: Read; entries: Map<string, Entry>; root: string | null }
    >();

    /**
     * A session that names a parameter (the `by` tag) gets that parameter's values in its own
     * layer, as Phoenix joins a topic: the first session starts one read and one watch per key;
     * later ones share them; the last to close stops them (a reference count, ADR 0059 7).
     */
    const join = (def: Def, param: Param, into: Scope.Handle | null, life?: AbortSignal) => {
      const own = reading.get(def)!;
      const id = named(param);
      let entry = own.entries.get(id);

      if (!entry) {
        const made: Entry = {
          refs: 0,
          values: new Map(),
          faults: {},
          listeners: new Set(),
          stop: new AbortController(),
        };
        entry = made;
        own.entries.set(id, made);

        const store: Store = { entry: made, load: own.event.load };
        const signal = AbortSignal.any([made.stop.signal, own.event.signal]);
        const keys = reader(def, own.event, own.read, store, param, signal);
        for (const key of def.keys) void keys.read(key).then(() => keys.loop(key));
      }
      const held = entry;
      // Into the session's own layer, or the root's cells when the root names the parameter.
      const apply = () => {
        if (life?.aborted) return; // the session closed: nothing writes there

        for (const [key, value] of held.values) {
          const cell = def.made[key]!;
          (into ? into.controller(cell) : own.event.load(cell, meta)).set(value);
        }
        (into ? into.controller(def.faults) : own.event.load(def.faults, meta)).set(held.faults);
      };
      held.refs++;
      held.listeners.add(apply);
      apply();
      return () => {
        held.listeners.delete(apply);
        if (--held.refs > 0) return;
        held.stop.abort();
        own.entries.delete(id);
      };
    };

    /** A throw is `failed`, whatever it carries: its kind is never read. The cause stays here, whole. */
    const failedAt =
      ({ log }: RunEvent, address: string) =>
      (error: unknown): Reply => {
        log.error("remoteData failed", {
          address,
          cause: String(error),
          stack: String(Object(error).stack ?? ""),
        });
        return { ok: false, kind: "failed", payload: {} };
      };

    const refusal = (out: unknown): Reply | null =>
      chain.isRefused(out) ? { ok: false, kind: "refused", payload: out.payload } : null;

    /** answer and stream: the protocol asks; the key's cell answers; failures become the envelope. */
    const serve = (def: Def, event: RunEvent) => {
      const { op, call: invocation, load } = event;
      const asked = (invocation?.input ?? invocation?.rawInput) as z.infer<typeof watchInput>;
      const own = load(def.state, meta).get();
      if (!own || !Object.hasOwn(def.cells, asked.address)) {
        return Promise.resolve(op === def.answer ? null : false);
      }
      return op === def.answer
        ? answerOne(def, event, asked, own)
        : streamOne(def, event, asked, own);
    };

    /**
     * A request's parameter, as each config tag admits it (the tag's own `parse`); undefined when
     * it does not fit; null when the definition is not keyed.
     */
    const paramIn = (def: Def, value: unknown): Param | null | undefined => {
      if (def.by === null) return null;
      if (typeof value !== "object" || value === null) return undefined;

      const out: Record<string, unknown> = {};
      try {
        for (const [key, t] of Object.entries(def.by)) out[key] = t(Object(value)[key]).value;
      } catch {
        return undefined;
      }
      return out;
    };

    const notParam: Reply = { ok: false, kind: "invalid", payload: { side: "server" } };

    /** The value of one slot now: held, else the fill for the parameter, else the initial. */
    const valueOf = async (
      def: Def,
      event: RunEvent,
      own: Served,
      key: string,
      param: Param | null,
    ) => {
      if (param === null) return own.roots.get(key)!.get();
      const at = param === null ? key : `${key}\u0000${named(param)}`;
      if (own.held.has(at)) return own.held.get(at);

      const fill = event.config.fill.present ? event.config.fill.value[key] : undefined;
      if (!fill) return def.cells[key]!.initial;

      // The fill runs as one call tagged with the parameter: it reads `by` as any request would.
      const tags = Object.entries(def.by!).map(([k, t]) => t(param[k]));
      return event.run(fill as never, { tags } as never, sending);
    };

    const answerOne = (
      def: Def,
      event: RunEvent,
      asked: z.infer<typeof callInput>,
      own: Served,
    ) => {
      const { address, meta: sent } = asked;
      const param = paramIn(def, asked.value);
      if (param === undefined) return Promise.resolve(notParam);
      const input = param === null ? { op: "get" } : { op: "get", param };
      return chain
        .runChain(event.run as never, event.config.use, address, input, sent, () =>
          valueOf(def, event, own, address, param),
        )
        .then((value): Reply => refusal(value) ?? { ok: true, value }, failedAt(event, address));
    };

    /** A watch: the value now, then each write, until the caller leaves. */
    const streamOne = (
      def: Def,
      event: RunEvent,
      asked: z.infer<typeof watchInput>,
      own: Served,
    ) => {
      const { run, config, signal } = event;
      const { address, meta: sent, push, left } = asked;
      const param = paramIn(def, asked.value);
      if (param === undefined) return (push(notParam), Promise.resolve(true));

      const at = param === null ? address : `${address}\u0000${named(param)}`;
      const input = param === null ? { op: "watch" } : { op: "watch", param };
      return chain
        .runChain(run as never, config.use, address, input, sent, async () => {
          const set = own.watchers.get(at) ?? new Map();
          own.watchers.set(at, set);

          // Join first, then read: a write that lands while the fill runs is pushed, not lost.
          const stop = left ?? signal;
          const ended = new Promise<void>((done) => {
            const end = () => {
              set.delete(push);
              if (set.size === 0) {
                own.watchers.delete(at);
                if (param !== null) own.held.delete(at); // no one watches: nothing to keep
              }
              done();
            };
            set.set(push, end);
            stop.addEventListener("abort", end, { once: true });
          });

          const now = await valueOf(def, event, own, address, param);
          if (param !== null && set.size > 0 && !own.held.has(at)) own.held.set(at, now);
          push({ ok: true, value: param === null ? now : (own.held.get(at) ?? now) }); // the value now
          return ended;
        })
        .then(
          (end) => (refusal(end) && push(refusal(end)!), true),
          (error) => (push(failedAt(event, address)(error)), true),
        );
    };

    return {
      faultOf,
      isFault,
      fits,
      serveStart,
      reader,
      readStart,
      join,
      named,
      faultsIn,
      paramIn,
      valueOf,
      isReading: (def: Def) => reading.has(def),
      rootParam: (def: Def) => reading.get(def)?.root ?? null,
      failedAt,
      refusal,
      serve,
      answerOne,
      streamOne,
    };
  },
});

type Steps = typeof steps extends Resource.Handle<infer T> ? Awaited<T> : never;

/**
 * A definition takes plain `data` cells, by key, as a short way to give each shape (initial,
 * parse, eq). It makes its OWN cell per key and exports those: `board.todos` is this capsule's
 * cell, not the one passed in. So two definitions never share a cell; each has its own source.
 * The key is the wire address; the protocol's codec turns values to text; a cell's `parse`, when
 * it has one, checks what arrives. One capsule; its config picks the job:
 * - `serve: true`: the app writes the cells; a write is the time to push.
 * - `read`: the protocol's `call` and `watch` fill the cells. Ready only when every cell is
 *   filled.
 * - `serve: true`: the source is the passed cells, which the server's writer ops set; this
 *   capsule copies each write to its own cell and pushes it.
 * Either way, a feature reads the definition's export, `useData(board.todos)`: a Core cell
 * export (ADR 0123), a reader with no controller. No write hook guards a client: the export
 * cannot write, and a raw write is the cell-write lint's to find.
 * Middleware (`use`) is config.
 * No error declarations. A fault is the call's own, from the protocol's fixed set (refused,
 * failed, invalid, link), told apart by brand: `board.fault.is(e)`. A fault never fails start,
 * so it never closes the scope. It is data: `board.faults` holds each key's last fault until a
 * good value arrives; the key's cell keeps its last good value (or its initial).
 */
export function remoteData<
  const D extends Cells,
  const P extends Readonly<Record<string, Tag.Handle<any>>> = {},
>(cells: D, { config = {} as P }: { readonly config?: P } = {}) {
  /**
   * The config: the app's own tags, as a capsule's config takes them (F12). The instance shows
   * each one (`board.project`), and all use goes through it: userland binds `board.project("p1")`
   * where it fits (the root, a session, a namespace); a server op reads `depends: { p:
   * board.project }`. Keyed when it names a tag.
   */
  const configKeys = Object.keys(config);
  const clash = configKeys.filter((key) => key in cells || reserved.includes(key));
  if (clash.length) {
    throw new Error(`remoteData: config ${clash.join(", ")} is a cell or reserved key`);
  }

  const by = configKeys.length > 0 ? (config as Def["by"]) : null;

  const keys = Object.keys(cells) as (keyof D & string)[];
  const taken = keys.filter((key) => reserved.includes(key));
  if (taken.length) throw new Error(`remoteData: ${taken.join(", ")} is a reserved key`);

  const keyOf = new Map<unknown, string>(keys.map((key) => [cells[key], key]));
  /** This definition's own cells: same shape, new identity. */
  const made = Object.fromEntries(
    keys.map((key) => {
      const shape = cells[key]!;
      return [
        key,
        data({ initial: shape.initial, parse: shape.parse, eq: (a, b) => shape.eq(a, b) }),
      ];
    }),
  ) as unknown as D;

  const brand = {};
  const fault = {
    is: (error: unknown): error is RemoteFault => Object(error)[brandKey] === brand,
  };

  const serveKey = tag<true>({ label: `${name}.serve` });
  const fillKey = tag<Fill>({ label: `${name}.fill` });

  /** The parameter in the caller's own layer: one build per layer, so a session reads its own tag. */
  const paramOf = resource({
    label: `${name}.param`,
    target: "session",
    depends: Object.fromEntries(
      Object.entries(config).map(([key, t]) => [key, (t as Tag.Handle<unknown>).optional]),
    ),
    factory: (deps: Readonly<Record<string, Tag.Presence<unknown>>>): Param | null => {
      if (!by) return null;

      const out: Record<string, unknown> = {};
      for (const key of configKeys) {
        if (!deps[key]?.present) return null; // a parameter names every config key
        out[key] = deps[key]!.value;
      }

      return out;
    },
  });

  const readKey = tag<Read>({ label: `${name}.read` });
  const useKey = tag<readonly Middleware[]>({ label: `${name}.use`, default: [] });

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

  const state = data<Served | null>({ label: `${name}.state`, initial: null });
  /**
   * On a reading root: each key's last fault, until a good value arrives. Exported as a read view,
   * `useData(board.faults).todos`: faults are data, as TanStack Query gives `{ data, error }`.
   * A plain read, so a session read and a `depends` see it too (ADR 0089 Limits: the module
   * exposes it; no resolve hook). Never mutated: a new object per change.
   */
  const faults = data<Readonly<Partial<Record<keyof D & string, RemoteFault>>>>({
    label: `${name}.faults`,
    initial: {} as Readonly<Partial<Record<keyof D & string, RemoteFault>>>,
  });
  const drop = operation({
    label: `${name}.drop`,
    depends: { own: state },
    run: ({ own }) => {
      for (const set of own?.watchers.values() ?? []) {
        for (const end of Array.from(set.values())) end();
      }
    },
  });
  const rooting = new Set<unknown>();

  // Pushes follow OTel messaging: the server runs `remoteData.send` (a producer span) per write; each
  // pushed reply carries it as `meta.traceparent`; a client runs `remoteData.receive` (a process
  // span) and records that span as a link. Core spans have no links, so the link is an event
  // with the W3C ids (OTel: a link names the creation context, not the parent). The wire
  // address is the topic name (`messaging.destination.name`).
  /** One write, sent to every watcher of its key: an OTel producer span. */
  const publish = operation({
    label: `${name}.send`,
    input: z.object({
      key: z.string(),
      value: z.unknown(),
      watchers: z.array(z.custom<(r: Reply) => void>((v) => typeof v === "function")),
    }),
    depends: { protocol },
    run: ({ protocol }, { input, obs, log }) => {
      if (obs.span) {
        Object.assign(obs.span.attributes, {
          "messaging.operation.type": "send",
          "messaging.destination.name": input.key,
          "messaging.batch.message_count": input.watchers.length,
        });
      }
      const sent: Reply = { ok: true, value: input.value, meta: protocol.traceparent(obs.span) };
      // One watcher that cannot take the push (its link just went) does not stop the others.
      for (const push of input.watchers) {
        try {
          push(sent);
        } catch (error) {
          log.error("remoteData push failed", { address: input.key, cause: String(error) });
        }
      }
    },
  });

  /** One read from the backend: a client span (OTel), whose trace id a fault carries. */
  const getting = operation({
    label: `${name}.get`,
    input: z.object({
      key: z.string(),
      go: z.custom<() => Promise<unknown>>((v) => typeof v === "function"),
    }),
    run: (_, { input, obs }) => {
      const traceId = obs.span?.traceId;
      return input.go().then(
        (value) => ({ value, traceId }),
        (error: unknown) => {
          if (fault.is(error) && traceId) {
            Object.assign(error, { traceId, message: `${error.message} (trace ${traceId})` });
          }
          throw error;
        },
      );
    },
  });

  const receive = operation({
    label: `${name}.receive`,
    input: z.object({
      key: z.string(),
      meta: z.record(z.string(), z.string()).optional(),
      apply: z.custom<(traceId: string | undefined) => void>((v) => typeof v === "function"),
    }),
    run: (_, { input, obs }) => {
      if (obs.span) {
        Object.assign(obs.span.attributes, {
          "messaging.operation.type": "process",
          "messaging.destination.name": input.key,
        });
      }
      const link = input.meta?.traceparent;
      if (link) obs.event("link", { traceparent: link });
      input.apply(obs.span?.traceId);
    },
  });

  const def: Def = {
    cells,
    made,
    keys,
    brand,
    state,
    faults: faults as Data.Cell<Faults>,
    answer,
    by,
    paramOf,
    getting,
    receive,
  };
  const own = data<Steps | null>({ label: `${name}.steps`, initial: null });

  const base = capsule({
    label: name,
    config: {
      serve: serveKey.optional,
      fill: fillKey.optional,
      read: readKey.optional,
      use: useKey,
    },
    exports: {
      ...made,
      faults,
      answer: answer as Answer,
      stream: stream as Stream,
      drop,
    } as unknown as { answer: Answer; stream: Stream; drop: typeof drop },
    hooks: {
      async start(event) {
        const { config, load, raise } = event;
        if (config.serve.present === config.read.present) {
          raise("MissingConfig", { label: name, key: "serve | read" });
        }
        const s = await load(steps, meta);
        load(own, meta).set(s);
        const start = event as unknown as StartEvent;

        return config.serve.present ? s.serveStart(def, start) : s.readStart(def, start);
      },

      run(event) {
        if (event.op !== answer && event.op !== stream) return event.next();
        return event
          .load(own, meta)
          .get()!
          .serve(def, event as unknown as RunEvent);
      },

      /** A keyed reading root: a session that names a parameter reads that parameter's values. */
      async session({ handle, next, load }) {
        if (!by) return next();
        const s = load(own, meta).get();
        if (!s || !s.isReading(def)) return next();

        const param = handle.resolve(paramOf);
        // No parameter, or the root's own: the session reads the root's cells through.
        if (param === null || s.rootParam(def) === s.named(param)) return next();

        const life = new AbortController();
        const leave = s.join(def, param, handle, life.signal);
        try {
          return await next();
        } finally {
          life.abort();
          leave();
        }
      },

      write({ cell, value, next, load, run, log }) {
        const key = keyOf.get(cell);
        if (key === undefined) return next();
        const served = load(state, meta).get();
        if (!served) return next(); // a reading root: nothing to push
        if (by) {
          // Keyed: the write stays where the writer made it; the writer's `by` tag names the
          // parameter, and only that parameter's watchers get it. A write with no parameter has
          // no one to go to: the log says so.
          next();
          void load(paramOf, meta)
            .then((param) => {
              if (param === null) {
                log.error("remoteData keyed write with no parameter", { address: key });
                return;
              }

              const at = `${key}\u0000${load(own, meta).get()!.named(param)}`;
              const watchers = [...(served.watchers.get(at)?.keys() ?? [])];
              if (!watchers.length) return; // no one watches: the next watch fills afresh

              served.held.set(at, value);
              return run(publish, { input: { key, value, watchers } }, sending);
            })
            .catch((error) =>
              log.error("remoteData send failed", { address: key, cause: String(error) }),
            );
          return;
        }
        // A request runs in a session, and a session keeps its writes (ADR 0090): the root holds the data.
        // The outer call sends, from the writer's own owner, so the send span is in the writer's trace.
        if (rooting.has(cell)) return next();
        rooting.add(cell);
        try {
          served.roots.get(key)!.set(value);
          served.copies.get(key)!.set(value);
        } finally {
          rooting.delete(cell);
        }
        const watchers = [...(served.watchers.get(key)?.keys() ?? [])];

        void run(publish, { input: { key, value, watchers } }, sending).catch((error) =>
          log.error("remoteData send failed", { address: key, cause: String(error) }),
        );
      },
    },
  });

  type Base = typeof base;
  /** One capsule. Its call takes a union (Core config is flat: this cast is the gap). */
  return Object.assign(base, { fault, addresses: keys }, config) as unknown as Omit<Base, never> &
    Capsule.Shown<D & { faults: typeof faults }> &
    P & {
      readonly answer: Answer;
      readonly stream: Stream;
      readonly drop: typeof drop;
      readonly fault: typeof fault;
      readonly addresses: readonly string[];
    } & {
      (values: Config): ReturnType<Base>;
    };
}
