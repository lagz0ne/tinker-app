import { resource } from "@tinker/core";
import type { Operation, Tag } from "@tinker/core";
import { z } from "zod";

// A middleware is a plain operation, written where it is used, and given to one capsule as config:
// `use` wraps every key (upstream); a service's `implement` entry may add to it or, with
// `inherit: false`, run its own chain (downstream). No shared declaration, no sides: the client
// capsule and the service capsule run the same step shape, each its own chain. What crosses the
// wire (an error kind) is protocol, declared on the definition. As Koa and TanStack Start, `next`
// is the rest of the chain.
//
// One step, both capsules:
//   meta  string pairs beside the body. The client sends what reaches the end of its chain;
//         a service sees what came in. next({ meta }) adds pairs for the rest.
//   tags  next({ tags }) binds them for the rest: the backend call on a client, the
//         implementation on a service.

export type Tags = Tag.Binding<unknown>[];
export type Meta = Record<string, string>;
export type Next = (more?: { meta?: Meta; tags?: Tags }) => Promise<unknown>;

/**
 * A middleware that says no returns `refuse(payload)`: a value, not a throw. The chain stops and
 * the call answers the `refused` fault with that payload (like HTTP 401/403).
 */
const refusedBrand = Symbol("refused");
export type Refused = { readonly [refusedBrand]: true; readonly payload: unknown };

export const step = z.object({
  key: z.string(),
  input: z.unknown(),
  meta: z.record(z.string(), z.string()),
  next: z.custom<Next>((v) => typeof v === "function"),
  refuse: z.custom<(payload: unknown) => Refused>((v) => typeof v === "function"),
});

export type Middleware = Operation.Handle<Promise<unknown>, z.infer<typeof step>>;

/**
 * A key's entry in a service's `implement`: a plain operation inherits the capsule's `use`;
 * `{ run, use }` adds after it; `{ run, inherit: false, use }` drops it and runs its own chain.
 */
export type Entry<Op> =
  | Op
  | { readonly run: Op; readonly use?: readonly Middleware[]; readonly inherit?: boolean };

type Own = {
  readonly run: unknown;
  readonly use?: readonly Middleware[];
  readonly inherit?: boolean;
};

const why = { role: "handler", explain: "A middleware" } as const;
type Run = (op: any, call: any, m: typeof why) => Promise<unknown>;

/**
 * The chain's tools, shared by rpc and remoteData: `refuse` and `isRefused` for a "no",
 * `runOf` and `chainOf` for an `implement` entry, `runChain` to run a chain.
 */
export const middleware = resource({
  label: "protocol.middleware",
  target: "scope",
  factory: () => {
    const refuse = (payload: unknown): Refused => ({ [refusedBrand]: true, payload });

    const isRefused = (value: unknown): value is Refused =>
      typeof value === "object" && value !== null && refusedBrand in value;

    // An operation handle has a `run` too, but its `run` is a function; an entry's `run` is a handle.
    const isOwn = (entry: unknown): entry is Own => typeof Object(entry).run === "object";
    const runOf = (entry: unknown): unknown => (isOwn(entry) ? entry.run : entry);

    const chainOf = (upstream: readonly Middleware[], entry: unknown): readonly Middleware[] =>
      !isOwn(entry)
        ? upstream
        : entry.inherit === false
          ? (entry.use ?? [])
          : [...upstream, ...(entry.use ?? [])];

    /** Runs a chain, then `last` with the meta and the tags it gathered. */
    const runChain = (
      run: Run,
      chain: readonly Middleware[],
      key: string,
      input: unknown,
      meta: Meta,
      last: (meta: Meta, tags: Tags) => Promise<unknown>,
      tags: Tags = [],
    ): Promise<unknown> => {
      const [first, ...rest] = chain;
      if (!first) return last(meta, tags);
      const next: Next = (more) =>
        runChain(run, rest, key, input, { ...meta, ...more?.meta }, last, [
          ...tags,
          ...(more?.tags ?? []),
        ]);

      return run(
        first,
        { input: { key, input, meta, next, refuse }, ...(tags.length ? { tags } : {}) },
        why,
      );
    };

    return { refuse, isRefused, isOwn, runOf, chainOf, runChain };
  },
});
