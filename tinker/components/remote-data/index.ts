import { capsule, data, operation, parse, resource, tag } from "@tinker/core";
import type { Capsule, Data, Operation, Scope, Tag } from "@tinker/core";
import { z } from "zod";

import { protocol } from "~/components/protocol";
import type { Answer, Call, Hooks, Stream, Watch } from "~/components/protocol";
import { channel, rpc } from "~/components/rpc";
import type { RpcFault } from "~/components/rpc";

// remoteData rides on rpc: each key is an rpc stream key at the same address. Its stream sends
// the value now, then each write. rpc owns the serving, the faults, the codec use and the hooks;
// remoteData owns the cells: who watches which key, what a write pushes, and the client's copy.

type Cells = Readonly<Record<string, Data.Cell<any>>>;

type Read = { readonly call: Call; readonly watch: Watch };

/** The job, picked by the config: serve the cells here, or fill them from a backend. */
type Job =
  | { readonly serve: true; readonly fill?: Fill; readonly read?: never }
  | { readonly read: Read; readonly serve?: never };

/** The lifecycle hooks go to the wire: rpc runs them, on each side, per key. */
type Config = Job & Hooks;

/**
 * A keyed definition's first value for one parameter, per key: an op the server runs in a call
 * tagged with the parameter, when a client asks for a parameter no write has given yet. With no
 * fill, the key's initial value goes out.
 */
type Fill = Readonly<Record<string, Operation.Handle<unknown, void>>>;

/** A fault of a definition: rpc's own, branded by the definition's wire. */
export type RemoteFault = RpcFault;

const meta = { role: "state", explain: "Remote data of this root" } as const;
const sending = { role: "handler", explain: "Sends one write to its watchers" } as const;
const reading = { role: "handler", explain: "Reads one key's stream" } as const;
const name = "remoteData"; // labels only: the wire address is the key
const reserved = ["answer", "stream", "drop", "fault", "faults"];

/** One watcher: rpc's `channel.send` of one stream. */
type Push = (value: unknown, meta?: Record<string, string>) => void;

/** A keyed definition's parameter: its config values, by config key (F12). */
type Param = Readonly<Record<string, unknown>>;

/** What a serving root keeps: each cell's root controller, and who watches each slot. */
type Served = {
  roots: Map<string, Scope.DataController<unknown>>;
  copies: Map<string, Scope.DataController<unknown>>;
  /** By slot: the key, or the key and its parameter. */
  watchers: Map<string, Map<Push, () => void>>;
  /** A keyed definition: each watched slot's last value, held while a client watches it. */
  held: Map<string, unknown>;
  /** The key's fill for one parameter, run on the root; undefined when the key has none. */
  fill: (key: string, param: Param) => Promise<unknown> | undefined;
};

/** A reading root's values for one parameter, shared by every session that names it. */
type Entry = {
  refs: number;
  values: Map<string, unknown>;
  faults: Faults;
  listeners: Set<() => void>;
  stop: AbortController;
};

type Faults = Readonly<Record<string, RemoteFault>>;

type Wire = {
  readonly receive: unknown;
  readonly fault: {
    is(error: unknown): error is RpcFault;
    make(address: string, kind: RpcFault["fault"], payload: unknown, traceId?: string): RpcFault;
  };
} & Readonly<Record<string, unknown>>;

/** One definition, as the steps read it. */
type Def = {
  readonly cells: Cells;
  readonly made: Cells;
  readonly keys: readonly string[];
  readonly wire: Wire;
  readonly state: Data.Cell<Served | null>;
  readonly faults: Data.Cell<Faults>;
  /** A keyed definition's config (F12): the app's own tags; null when not keyed. */
  readonly by: Readonly<Record<string, Tag.Handle<unknown>>> | null;
  /** The parameter in the caller's own layer: every config tag's value there, or null. */
  readonly paramOf: import("@tinker/core").Resource.Handle<Param | null>;
  readonly missingOf: import("@tinker/core").Resource.Handle<string | null>;
};

type Shape = {
  readonly serve: Tag.Presence<true>;
  readonly fill: Tag.Presence<Fill>;
  readonly read: Tag.Presence<Read>;
};

type StartEvent = Omit<Capsule.Events["start"], "config"> & { readonly config: Shape };
type RunEvent = Omit<Capsule.Events["run"], "config"> & { readonly config: Shape };

/** A reader's store: the root's own cells (no entry), or one parameter's entry. */
type Store = { readonly entry: Entry | null; readonly load: StartEvent["load"] };

/** The steps every remoteData capsule runs. */
const steps = resource({
  label: "remoteData.steps",
  target: "scope",
  factory: () => {
    /** One parameter as text: its entries in key order, so equal values name one slot. */
    const named = (param: Param) =>
      JSON.stringify(
        Object.keys(param)
          .sort()
          .map((key) => [key, param[key]]),
      );

    const slot = (key: string, param: Param | null) =>
      param === null ? key : `${key}\u0000${named(param)}`;

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
    const serveStart = (def: Def, { load, next, config, run }: StartEvent) => {
      const roots = new Map(def.keys.map((key) => [key, load(def.cells[key]!, meta)] as const));
      const copies = new Map(def.keys.map((key) => [key, load(def.made[key]!, meta)] as const));
      for (const key of def.keys) copies.get(key)!.set(roots.get(key)!.get());

      const fill = (key: string, param: Param) => {
        const op = config.fill.present ? config.fill.value[key] : undefined;
        if (!op) return undefined;
        // The fill runs as one call tagged with the parameter: it reads `by` as any request would.
        const tags = Object.entries(def.by!).map(([k, t]) => t(param[k]));
        return Promise.resolve(run(op as never, { tags } as never, sending as never));
      };
      load(def.state, meta).set({ roots, copies, watchers: new Map(), held: new Map(), fill });
      return next();
    };

    /** The value of one slot now: held, else the fill for the parameter, else the initial. */
    const valueOf = async (def: Def, own: Served, key: string, param: Param | null) => {
      if (param === null) return own.roots.get(key)!.get();
      const at = slot(key, param);
      if (own.held.has(at)) return own.held.get(at);
      return (await own.fill(key, param)) ?? def.cells[key]!.initial;
    };

    /** A watch, as rpc runs it: the value now, then each write, until the caller leaves. */
    const watch = async (
      def: Def,
      own: Served,
      key: string,
      param: Param | null,
      out: { send: Push; closed: AbortSignal },
    ) => {
      const at = slot(key, param);
      const set = own.watchers.get(at) ?? new Map<Push, () => void>();
      own.watchers.set(at, set);

      // Join first, then read: a write that lands while the fill runs is pushed, not lost.
      const ended = new Promise<void>((done) => {
        const end = () => {
          if (!set.delete(out.send)) return done();
          if (set.size === 0) {
            own.watchers.delete(at);
            if (param !== null) own.held.delete(at); // no one watches: nothing to keep
          }
          done();
        };
        set.set(out.send, end);
        if (out.closed.aborted) end();
        else out.closed.addEventListener("abort", end, { once: true });
      });

      const now = await valueOf(def, own, key, param);
      if (param !== null && set.size > 0 && !own.held.has(at)) own.held.set(at, now);
      out.send(param === null ? now : (own.held.get(at) ?? now)); // the value now
      return ended;
    };

    /** A store's faults now: its entry's, or the root's cell. */
    const faultsIn = (def: Def, store: Store): Faults =>
      store.entry ? store.entry.faults : store.load(def.faults, meta).get();

    /** A reading root's steps for one parameter (or none): they share its start's run and log. */
    const reader = (
      def: Def,
      event: StartEvent,
      store: Store,
      param: Param | null,
      signal: AbortSignal,
    ) => {
      const { run, clock, log } = event;

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

      /** A value that does not fit the cell's parse is `invalid` (side "client"), not a skip. */
      const set = (key: string, value: unknown, traceId?: string) => {
        const checked = fits(def, key, value);
        if (!checked.ok) {
          log.error("remoteData value refused", { address: key, why: checked.why });
          return mark(key, def.wire.fault.make(key, "invalid", { side: "client" }, traceId));
        }
        if (store.entry) {
          store.entry.values.set(key, checked.value);
          store.entry.listeners.forEach((listener) => listener());
        } else store.load(def.made[key]!, meta).set(checked.value);
        mark(key, null);
      };

      /** One round of a key's stream, until it ends: the fault it ended with, or null. */
      const round = async (key: string, first: () => void): Promise<RemoteFault | null> => {
        const done = new AbortController();
        try {
          const values = (await run(
            def.wire[key] as never,
            { input: param } as never,
            reading as never,
          )) as AsyncIterable<unknown> & {
            readonly meta?: Record<string, string>;
            stop(reason?: unknown): void;
          };

          // Not the run's own signal: a call with one ends its layer, and the stream with it,
          // when the call returns. The loop's signal stops the stream instead; the listener
          // goes with the round, so rounds do not pile listeners on the signal.
          signal.addEventListener("abort", () => values.stop(signal.reason), {
            once: true,
            signal: done.signal,
          });
          if (signal.aborted) values.stop(signal.reason);

          for await (const value of values) {
            // One process span per push (OTel messaging), linked to the writer's send span.
            const traceId = (await run(
              def.wire.receive as never,
              { input: { key, meta: values.meta } } as never,
              reading as never,
            )) as string | undefined;
            set(key, value, traceId);
            first();
          }
          return null;
        } catch (error) {
          return def.wire.fault.is(error) ? error : def.wire.fault.make(key, "link", {});
        } finally {
          done.abort();
        }
      };

      /**
       * Keeps a key fresh: its rpc stream, again after it ends or faults, with back-off while
       * faulted (as EventSource retry). A stream's first push is the value now, so a reopen is
       * the catch-up read. `first` settles on the first value or fault.
       */
      const loop = async (key: string, first: () => void) => {
        for (let wait = 50; !signal.aborted;) {
          const ended = await round(key, first);
          if (!signal.aborted && ended) mark(key, ended);
          first();
          if (signal.aborted) break;

          wait = Object.hasOwn(faultsIn(def, store), key) ? Math.min(wait * 2, 5000) : 50;
          await clock.sleep(wait, signal).catch(() => undefined);
        }
      };

      return { mark, set, round, loop };
    };

    /** A keyed reading root: its start context, and one entry per parameter some session names. */
    const readers = new Map<
      Def,
      { event: StartEvent; entries: Map<string, Entry>; root: string | null }
    >();

    /** Starts every key's loop; resolves once each has its first value or fault. */
    const keep = (def: Def, keys: ReturnType<typeof reader>) =>
      Promise.all(
        def.keys.map(
          (key) =>
            new Promise<void>((done) => {
              void keys.loop(key, done);
            }),
        ),
      );

    /**
     * A session that names a parameter gets that parameter's values in its own layer, as Phoenix
     * joins a topic: the first session starts one stream per key; later ones share them; the
     * last to close stops them (a reference count, ADR 0059 7).
     */
    const join = (def: Def, param: Param, into: Scope.Handle | null, life?: AbortSignal) => {
      const own = readers.get(def)!;
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
        void keep(def, reader(def, own.event, store, param, signal));
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

    /** Read: fill every cell from the backend, then keep it fresh. */
    const readStart = async (def: Def, event: StartEvent) => {
      const { config, raise, next, load, signal } = event;
      if (!config.read.present) return raise("MissingConfig", { label: name, key: "read" });
      // A keyed definition reads nothing at the root: each session that names a parameter does.
      if (def.by) {
        readers.set(def, { event, entries: new Map(), root: null });
        const param = await load(def.paramOf, meta);
        if (param !== null) {
          readers.get(def)!.root = named(param);
          join(def, param, null);
        }
        return next();
      }
      // A fault on the first value does not fail start: the cell keeps its initial value, and
      // `board.faults` shows the fault.
      await keep(def, reader(def, event, { entry: null, load }, null, signal));
      return next();
    };

    return {
      named,
      keep,
      reader,
      valueOf,
      faultsIn,
      slot,
      fits,
      serveStart,
      watch,
      readStart,
      join,
      /**
       * A server op that writes a keyed cell runs only with every config tag bound: with none,
       * its write would go to no one, so it fails before it runs (`MissingTag`, as Core says it).
       */
      guardKeyed: (def: Def, event: RunEvent) => {
        const cells: readonly unknown[] = Object.values(def.cells);
        const writes = Object.values(Object(Object(event.op).depends)).some(
          (d) => Object(d).kind === "controller" && cells.includes(Object(d).target),
        );
        if (!writes) return event.next();

        return event
          .load(def.missingOf, meta)
          .then((missing) =>
            missing === null ? event.next() : event.raise("MissingTag", { label: missing }),
          );
      },
      isReading: (def: Def) => readers.has(def),
      rootParam: (def: Def) => readers.get(def)?.root ?? null,
    };
  },
});

type Steps = Awaited<ReturnType<(typeof steps)["factory"]>>;

/**
 * A definition takes plain `data` cells, by key, as a short way to give each shape (initial,
 * parse, eq). It makes its OWN cell per key and exports those as read views (ADR 0123):
 * `useData(board.todos)`. Each key is an rpc stream key at the same address; `board(...)`
 * installs that rpc capsule and this one:
 * - `serve: true`: the app's writer ops set the passed cells; each write is pushed to the key's
 *   watchers.
 * - `read`: each key's stream fills its cell. Ready once every key has its first value or fault.
 * Faults are rpc's, branded by the definition: `board.fault.is(e)`. They are data:
 * `board.faults` holds each key's last fault until a good value arrives. A fault never fails
 * start.
 */
export function remoteData<
  const D extends Cells,
  const P extends Readonly<Record<string, Tag.Handle<any>>> = {},
>(cells: D, { config = {} as P }: { readonly config?: P } = {}) {
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

  /** The parameter on the wire: each config tag admits its own value (the tag's `parse`). */
  const param =
    by === null
      ? z.null()
      : z
          .custom<Param>((value) => {
            if (typeof value !== "object" || value === null) return false;
            try {
              for (const [key, t] of Object.entries(by)) t(Object(value)[key]);
              return true;
            } catch {
              return false;
            }
          })
          .transform((value) =>
            Object.fromEntries(Object.entries(by).map(([key, t]) => [key, t(value[key]).value])),
          );

  // The wire: one rpc stream key per cell. Values cross as they are; the cell's parse checks them
  // on the client, where a misfit is a fault the key shows (`invalid`), not a broken stream.
  const wire = rpc(
    Object.fromEntries(
      keys.map((key) => [key, { mode: "stream" as const, input: param, output: z.unknown() }]),
    ),
    { label: name },
  ) as unknown as Wire &
    ((values: unknown) => Capsule.Installable) & {
      readonly answer: Answer;
      readonly stream: Stream;
    };

  const serveKey = tag<true>({ label: `${name}.serve` });
  const fillKey = tag<Fill>({ label: `${name}.fill` });
  const readKey = tag<Read>({ label: `${name}.read` });

  const configDepends = Object.fromEntries(
    Object.entries(config).map(([key, t]) => [key, (t as Tag.Handle<unknown>).optional]),
  );

  /** The parameter in the caller's own layer: one build per layer, so a session reads its own tag. */
  const paramOf = resource({
    label: `${name}.param`,
    target: "session",
    depends: configDepends,
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

  const missingOf = resource({
    label: `${name}.missing`,
    target: "session",
    depends: configDepends,
    factory: (deps: Readonly<Record<string, Tag.Presence<unknown>>>): string | null => {
      const absent = configKeys.find((key) => !deps[key]?.present);
      return absent === undefined ? null : (config[absent] as Tag.Handle<unknown>).label;
    },
  });

  const state = data<Served | null>({ label: `${name}.state`, initial: null });
  /**
   * On a reading root: each key's last fault, until a good value arrives. A read view,
   * `useData(board.faults).todos`: faults are data, as TanStack Query gives `{ data, error }`.
   */
  const faults = data<Readonly<Partial<Record<keyof D & string, RemoteFault>>>>({
    label: `${name}.faults`,
    initial: {} as Readonly<Partial<Record<keyof D & string, RemoteFault>>>,
  });

  const def: Def = {
    cells,
    made,
    keys,
    wire,
    state,
    faults: faults as Data.Cell<Faults>,
    by,
    paramOf,
    missingOf,
  };

  /** Each key's stream, as rpc runs it on the server: the value now, then each write. */
  const implement = Object.fromEntries(
    keys.map((key) => [
      key,
      operation({
        label: `${name}.watch`,
        input: param,
        depends: { out: channel, own: state, s: steps },
        run: ({ out, own, s }, { input }) =>
          s.watch(def, own!, key, (input ?? null) as Param | null, out),
      }),
    ]),
  );

  /** Ends every watch this root serves (a test's way to drop the links). */
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

  // Pushes follow OTel messaging: the server runs `remoteData.send` (a producer span) per write;
  // each push carries it as `meta.traceparent`; rpc's `remoteData.receive` on the client links it.
  const publish = operation({
    label: `${name}.send`,
    input: z.object({
      key: z.string(),
      value: z.unknown(),
      watchers: z.array(z.custom<Push>((v) => typeof v === "function")),
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
      const sent = protocol.traceparent(obs.span);
      // One watcher that cannot take the push (its link just went) does not stop the others.
      for (const push of input.watchers) {
        try {
          push(input.value, sent);
        } catch (error) {
          log.error("remoteData push failed", { address: input.key, cause: String(error) });
        }
      }
    },
  });

  const own = data<Steps | null>({ label: `${name}.steps`, initial: null });

  const base = capsule({
    label: name,
    config: { serve: serveKey.optional, fill: fillKey.optional, read: readKey.optional },
    exports: { ...made, faults, drop } as unknown as { drop: typeof drop },
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
        if (!by || !event.load(state, meta).get()) return event.next();
        return event
          .load(own, meta)
          .get()!
          .guardKeyed(def, event as unknown as RunEvent);
      },

      /** A keyed reading root: a session that names a parameter reads that parameter's values. */
      async session({ handle, next, load }) {
        if (!by) return next();
        const s = load(own, meta).get();
        if (!s || !s.isReading(def)) return next();

        const asked = handle.resolve(paramOf);
        // No parameter, or the root's own: the session reads the root's cells through.
        if (asked === null || s.rootParam(def) === s.named(asked)) return next();

        const life = new AbortController();
        const leave = s.join(def, asked, handle, life.signal);
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
          // parameter, and only that parameter's watchers get it.
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
        // A request runs in a session, and a session keeps its writes (ADR 0090): the root holds
        // the data. The outer call sends, from the writer's own owner, so the send span is in the
        // writer's trace.
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

  /** One call installs two capsules: the wire (rpc), then the cells (this one). */
  const install = ({ retry, onStart, onSuccess, onError, onFinish, ...job }: Config) => {
    const hooks = Object.fromEntries(
      Object.entries({ retry, onStart, onSuccess, onError, onFinish }).filter(([, v]) => v),
    );
    return [
      wire("serve" in job && job.serve ? { implement, ...hooks } : { remote: job.read, ...hooks }),
      base(job as never),
    ];
  };
  Object.defineProperties(install, Object.getOwnPropertyDescriptors(base));

  type Base = typeof base;
  const fault = { is: (error: unknown): error is RemoteFault => wire.fault.is(error) };
  return Object.assign(install, {
    fault,
    addresses: keys,
    answer: wire.answer,
    stream: wire.stream,
    ...config,
  }) as unknown as Omit<Base, never> &
    Capsule.Shown<D & { faults: typeof faults }> &
    P & {
      readonly answer: Answer;
      readonly stream: Stream;
      readonly drop: typeof drop;
      readonly fault: { is(error: unknown): error is RemoteFault };
      readonly addresses: readonly string[];
    } & {
      (values: Config): Capsule.Installable;
    };
}
