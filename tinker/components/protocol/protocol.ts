import { resource } from "@tinker/core";
import type { Observe, Operation, Resource } from "@tinker/core";

import type { Codec, Delta, Open, Pushes, Reply, Send, Service, Streams } from "./wire";

// The protocol: the reply envelope, the fault set, the codec use, push forms and the route
// table. Fixed: any transport carries it (glossary "protocol", ADR 0048). It is not a capsule.
// Each transport (sse, memory) is one client and one server capsule that speaks it, as each
// Connect RPC transport speaks one protocol over its own wire.

/**
 * `meta`: an op the client runs before each call and each stream open; its pairs go beside the
 * body (headers). As tRPC's `headers()` or a gRPC call credential.
 * `renew`: runs when a call or a push is `refused`, as OkHttp's Authenticator runs on a 401.
 * True means "try once more" (the next `meta` has fresh credentials). One renew at a time per
 * transport: calls refused together wait for the same one (single flight).
 */
export type MetaOp = Operation.Handle<Promise<Record<string, string>>, void>;

export type RenewOp = Operation.Handle<
  Promise<boolean>,
  { payload: unknown; sent: Record<string, string> }
>;

/** What a client transport holds once started: its text ops and the options it was given. */
export type ClientSide = {
  readonly send: Send;
  readonly open: Open;
  readonly codec: Codec;
  readonly pushes?: Pushes;
  readonly streams?: Streams;
  readonly meta?: MetaOp;
  readonly renew?: RenewOp;
  /**
   * The transport's own run, from its start: a shared stream opens on it, so it belongs to the
   * root, as an HTTP/2 connection belongs to the client, not to the request that opened it.
   */
  readonly root?: Hook["run"];
};

/** What a server transport holds once started: its codec and its route table. */
export type ServerSide = { readonly codec: Codec; readonly routes: ReadonlyMap<string, Service> };

/** The hook's own tools: run (with a handler note), log, and the call's signal. */
export type Hook = {
  readonly run: (op: never, options: never, why: never) => unknown;
  readonly log: Observe.Logger;
  readonly signal: AbortSignal | undefined;
};

/** Where a started transport keeps its side. */
export const kept = { role: "state", explain: "The transport's own side" } as const;

/** The shared stream's address. Its text is the list of [address, text] it carries. */
export const shared = "*";

/**
 * The most text one watch may carry, in UTF-8 bytes. A watch is a GET on SSE, so its text rides
 * in the URL, where a proxy refuses a long one (HTTP 414; nginx keeps 8 KiB for a request line).
 * URL encoding can triple the text, so 2 KiB stays under that. The protocol holds the line on
 * every transport, so memory behaves as SSE does: the client sends nothing longer (encode), the
 * server reads nothing longer (invalid: a stream that says why), and a shared stream splits before
 * it grows past it.
 */
export const watchTextMax = 2048;

/** Watches waiting for the tick's shared stream, per client side. */
const waiting = new WeakMap<object, Member[]>();

/** The renew in flight, per client side. */
const renewing = new WeakMap<object, Promise<boolean>>();

type Member = {
  address: string;
  text: string;
  got: (text: string) => void;
  done: () => void;
  gone: boolean;
  /** The shared stream this member rides, once the tick opened it. */
  part?: { members: Member[]; stop: AbortController };
};

/** RFC 3229 words: the client's ask, as a header beside the body. */
const asks = { "a-im": "text-delta" } as const;

/** A delta push: the value's text changes by `delta`. A fault push is a plain Reply. */
type DeltaFrame = { ok: true; delta: Delta; meta?: Record<string, string> };

/** A fault from the codec: `encode` or `decode`, saying only the side. */
type Failed = Extract<Reply, { ok: false }>;
type Coded<T> = { ok: true; value: T } | Failed;

const link: Reply = { ok: false, kind: "link", payload: {} };
const why = { role: "handler", explain: "One layer down" } as const;

/** Optional config, read as plain values. */
type Maybe<T> = { readonly present: boolean; readonly value?: T };

/**
 * The protocol's steps, for each transport's capsules: the client's `callOver` and `watchOver`,
 * the server's `serveText` and `streamText`, the route table, the codec use, and the default
 * codec (`json`). One per root; it holds nothing of its own.
 */
export const protocol = resource({
  label: "protocol",
  target: "scope",
  factory: () => {
    const run = <T>(hook: Hook, op: unknown, options: unknown) =>
      Promise.resolve(hook.run(op as never, options as never, why as never) as T);

    /** The codec a transport uses when none is given. */
    const json: Codec = {
      serialize: (value) => JSON.stringify(value ?? null),
      deserialize: (text) => JSON.parse(text),
    };

    /** The changed span of a text, and the text it gives. From "" a delta is the whole text. */
    const delta = {
      between(before: string, after: string): Delta {
        const most = Math.min(before.length, after.length);
        let at = 0;
        while (at < most && before[at] === after[at]) at++;

        let tail = 0;
        while (tail < most - at && before.at(-1 - tail) === after.at(-1 - tail)) tail++;
        return { at, cut: before.length - at - tail, add: after.slice(at, after.length - tail) };
      },
      apply(before: string, d: Delta): string {
        return before.slice(0, d.at) + d.add + before.slice(d.at + d.cut);
      },
    };

    /** W3C traceparent from a span: the client transport sends its own span (ADR 0076). */
    const traceparent = (
      span: { traceId: string; spanId: string; sampled: boolean } | undefined,
    ): Record<string, string> =>
      span
        ? { traceparent: `00-${span.traceId}-${span.spanId}-${span.sampled ? "01" : "00"}` }
        : {};

    const given = <T>(slot: Maybe<T>): T | undefined => (slot.present ? slot.value : undefined);

    /**
     * The route table: built once at start. Two services with one address: the first in the
     * list wins and start logs a warning, as Hono does (Duke 2026-11-06 04:21). `strict`
     * makes it fail start with DuplicateAddress instead.
     */
    const routesOf = (
      services: readonly Service[],
      raise: (kind: string, payload: unknown) => never,
      log: Observe.Logger,
      strict: boolean,
    ) => {
      const table = new Map<string, Service>();
      for (const service of services) {
        for (const address of service.addresses) {
          const label = String(service.label);
          if (address === shared) raise("ReservedAddress", { address, service: label });
          const taken = table.get(address);
          if (!taken) {
            table.set(address, service);
            continue;
          }

          const pair = { address, services: [String(taken.label), label] };
          if (strict) raise("DuplicateAddress", pair);
          log.warn("protocol duplicate address", {
            address,
            winner: pair.services[0],
            shadowed: label,
          });
        }
      }

      return table;
    };

    /** The codec, used on one side: a fault keeps its cause in this side's log, and says only the side. */
    const coding = (codec: Codec, side: "client" | "server", log: Observe.Logger) => {
      const fault = (kind: "encode" | "decode", address: string, error: unknown): Failed => {
        log.error(`protocol ${kind} failed`, {
          address,
          side,
          cause: String(error),
          stack: String(Object(error).stack ?? ""),
        });
        return { ok: false, kind, payload: { side } };
      };

      const encode = (address: string, value: unknown): Coded<string> => {
        try {
          return { ok: true, value: codec.serialize(value) };
        } catch (error) {
          return fault("encode", address, error);
        }
      };

      const decode = (address: string, text: string): Coded<unknown> => {
        try {
          return { ok: true, value: codec.deserialize(text) };
        } catch (error) {
          return fault("decode", address, error);
        }
      };

      return {
        fault,
        encode,
        decode,
        /** A reply as text. A reply the codec cannot carry goes out as the encode fault instead. */
        answerText: (address: string, reply: Reply): string => {
          const text = encode(address, reply);
          return text.ok ? text.value : codec.serialize(text);
        },
        replyOf: (address: string, text: string): Reply => {
          const reply = decode(address, text);
          return reply.ok ? (reply.value as Reply) : reply;
        },
      };
    };

    /** Client: the meta for a request, and the shared renew. */
    const asking = async (own: ClientSide, hook: Hook, given: Record<string, string>) => {
      const metaNow = async () =>
        own.meta ? { ...given, ...(await run<Record<string, string>>(hook, own.meta, {})) } : given;
      const meta = await metaNow();

      /** Refused: ask `renew` once (shared by the calls refused at the same time). */
      const renewed = (payload: unknown, sent: Record<string, string>): Promise<boolean> => {
        const renew = own.renew;
        if (!renew) return Promise.resolve(false);
        const live = renewing.get(own);
        if (live) return live;

        const once = run<boolean>(hook, renew, { input: { payload, sent } })
          .catch(() => false)
          .finally(() => renewing.delete(own));
        renewing.set(own, once);
        return once;
      };
      return { meta, metaNow, renewed };
    };

    /** Client: one value out, the reply back as a value. A fault is data too; only a bug throws. */
    const callOver = async (
      own: ClientSide,
      hook: Hook,
      input: { address: string; value: unknown; meta: Record<string, string> },
    ): Promise<Reply> => {
      const { encode, replyOf } = coding(own.codec, "client", hook.log);
      const { address } = input;
      const { meta, metaNow, renewed } = await asking(own, hook, input.meta);
      const body = encode(address, input.value);
      if (!body.ok) return body; // nothing is sent

      const ask = async (m: Record<string, string>): Promise<Reply> => {
        const text = await run<string>(hook, own.send, {
          input: { address, text: body.value, meta: m },
          signal: hook.signal,
        }).catch(() => null);
        return text === null ? link : replyOf(address, text);
      };
      const first = await ask(meta);
      if (first.ok || first.kind !== "refused" || !(await renewed(first.payload, meta))) {
        return first;
      }

      return metaNow().then(ask); // once only: a second refusal is the answer
    };

    /** Client: one value out; replies pushed until the signal aborts or the stream ends. */
    const watchOver = async (
      own: ClientSide,
      hook: Hook,
      input: {
        address: string;
        value: unknown;
        meta: Record<string, string>;
        push: (reply: Reply) => void;
      },
    ): Promise<void> => {
      const { codec } = own;
      const { encode, decode, replyOf } = coding(codec, "client", hook.log);
      const { address, push: up } = input;
      const { signal } = hook;
      const { meta, renewed } = await asking(own, hook, input.meta);
      const body = encode(address, input.value);
      if (!body.ok) return up(body); // nothing is sent

      // Too long to carry: a fault the caller sees at once, never a URL a proxy cuts.
      if (
        new TextEncoder().encode(codec.serialize([[address, body.value]])).byteLength > watchTextMax
      ) {
        hook.log.error("protocol watch too long", { address, max: watchTextMax });
        return up({ ok: false, kind: "encode", payload: { side: "client", max: watchTextMax } });
      }

      const wantsDelta = own.pushes === "delta";
      // Delta: keep the last value text of this stream; each push changes it.
      let last = "";
      const got = (text: string) => {
        let reply = replyOf(address, text) as Reply | DeltaFrame;
        if (wantsDelta && reply.ok && "delta" in reply) {
          last = delta.apply(last, reply.delta);
          const value = decode(address, last);
          reply = value.ok ? { ok: true, value: value.value, meta: reply.meta } : value;
        }
        // A refused push starts a renew; the watch's own retry then opens with fresh meta.
        if (!reply.ok && reply.kind === "refused") void renewed(reply.payload, meta);
        up(reply as Reply);
      };
      const ask = wantsDelta ? { ...meta, ...asks } : meta;
      if (own.streams !== "one") {
        return run<void>(hook, own.open, {
          input: { address, text: body.value, meta: ask, push: got },
          signal,
        });
      }

      // One stream: join this tick's group. The first watch opens it on the next tick. Each part
      // of the group (split so no part's text passes the cap) is one stream, held until every
      // member of that part has left; a member's watch ends when it leaves.
      const group = waiting.get(own) ?? [];
      const lead = group.length === 0;
      return new Promise<void>((done) => {
        const member: Member = { address, text: body.value, got, done, gone: false };
        group.push(member);

        const leave = () => {
          member.gone = true;
          done();
          if (member.part?.members.every((m) => m.gone)) member.part.stop.abort();
        };
        if (signal?.aborted) leave();
        else signal?.addEventListener("abort", leave, { once: true });
        if (!lead) return;

        waiting.set(own, group);
        setTimeout(() => {
          waiting.delete(own);
          const parts: Member[][] = [];
          for (const m of group.filter((each) => !each.gone)) {
            const last = parts.at(-1);
            const fits =
              last &&
              new TextEncoder().encode(
                codec.serialize([...last, m].map((each) => [each.address, each.text])),
              ).byteLength <= watchTextMax;
            if (fits) last.push(m);
            else parts.push([m]);
          }

          return Promise.all(
            parts.map((members) => {
              const stop = new AbortController();
              for (const m of members) m.part = { members, stop };

              // A frame entry is `[address, text, place]`. The place names the member, as an
              // HTTP/2 frame names its stream: two members can share an address and differ by
              // value (F12). A server from before sends `[address, text]`: route by address.
              const frame = (text: string) => {
                const all = decode(shared, text);
                if (!all.ok) return members.forEach((m) => m.got(codec.serialize(all)));
                for (const [to, t, at] of all.value as [string, string, number?][]) {
                  const m =
                    at === undefined ? members.find((each) => each.address === to) : members[at];
                  m?.got(t);
                }
              };
              const list = codec.serialize(members.map((m) => [m.address, m.text]));
              // The shared stream cannot open (or breaks): every member's key gets link.
              // Not on the lead's run: when the lead leaves, Core would end the stream with it.
              const holder = own.root ? { ...hook, run: own.root } : hook;
              return run<void>(holder, own.open, {
                input: { address: shared, text: list, meta: ask, push: frame },
                signal: stop.signal,
              })
                .catch(() => {
                  if (stop.signal.aborted) return;
                  members.forEach((m) => m.gone || m.got(codec.serialize(link)));
                })
                .finally(() => members.forEach((m) => m.done()));
            }),
          );
        }, 0);
      });
    };

    /** A service that throws (a bug: rpc and remoteData turn their own throws into `failed`): `failed` too, never a silent end. */
    const broke =
      (log: Observe.Logger, address: string) =>
      (error: unknown): Reply => {
        log.error("protocol service failed", {
          address,
          cause: String(error),
          stack: String(Object(error).stack ?? ""),
        });
        return { ok: false, kind: "failed", payload: {} };
      };

    /** Server: one text in, the reply text out; null when no service has the address (404). */
    const serveText = async (
      own: ServerSide,
      hook: Hook,
      input: { address: string; text: string; meta: Record<string, string> },
    ): Promise<string | null> => {
      const { codec, routes } = own;
      const { decode, answerText } = coding(codec, "server", hook.log);
      const { address, meta } = input;
      const read = decode(address, input.text);
      if (!read.ok) return codec.serialize(read);
      const service = routes.get(address);
      if (!service) return null; // no one has this address: the transport says 404

      const reply = await run<Reply | null>(hook, service.answer, {
        input: { address, value: read.value, meta },
        signal: hook.signal,
      }).catch(broke(hook.log, address));

      return reply === null ? null : answerText(address, reply);
    };

    /** Server: one watched address, its pushes as text (whole, or delta when asked). */
    const streamOne = async (
      own: ServerSide,
      hook: Hook,
      input: { address: string; value: unknown; meta: Record<string, string>; left?: AbortSignal },
      out: (text: string) => void,
    ): Promise<boolean> => {
      const { codec, routes } = own;
      const { encode, answerText } = coding(codec, "server", hook.log);
      const { address, value, meta, left } = input;
      // The client asked for deltas: send each value's text as a change against the last one.
      let last = "";
      const send =
        meta["a-im"] === asks["a-im"]
          ? (reply: Reply) => {
              if (!reply.ok) return out(answerText(address, reply));
              const text = encode(address, reply.value);
              if (!text.ok) return out(codec.serialize(text));
              const frame: DeltaFrame = {
                ok: true,
                delta: delta.between(last, text.value),
                meta: reply.meta,
              };
              last = text.value;

              out(answerText(address, frame as unknown as Reply));
            }
          : (reply: Reply) => out(answerText(address, reply));
      const service = routes.get(address);
      // No one has this address. Over its own stream the client would see only an end, so the
      // stream says it: link, as a 404 on a call.
      if (!service) return (send(link), false);

      return run<boolean>(hook, service.stream, {
        input: { address, value, meta, left, push: send },
      }).catch((error) => (send(broke(hook.log, address)(error)), true));
    };

    /** Server: pushes reply texts (whole, or delta when asked) until the client leaves. */
    const streamText = async (
      own: ServerSide,
      hook: Hook,
      input: {
        address: string;
        text: string;
        meta: Record<string, string>;
        push: (text: string) => void;
        left?: AbortSignal;
      },
    ): Promise<boolean> => {
      const { codec } = own;
      const { decode } = coding(codec, "server", hook.log);
      const { meta, push, left } = input;
      if (new TextEncoder().encode(input.text).byteLength > watchTextMax) {
        hook.log.error("protocol watch too long", { address: input.address, max: watchTextMax });
        push(codec.serialize({ ok: false, kind: "invalid", payload: { side: "server" } }));
        return true;
      }

      const read = decode(input.address, input.text);
      if (!read.ok) return (push(codec.serialize(read)), true);
      if (input.address !== shared) {
        return streamOne(
          own,
          hook,
          { address: input.address, value: read.value, meta, left },
          push,
        );
      }

      // The shared stream: every address it carries, at once. The pushes of one tick go out as one
      // frame, so the keys one write changed arrive together. An entry is `[address, text, place]`:
      // a client from before reads the first two and routes by address, as it did.
      let frame: [string, string, number][] = [];
      const flush = () => {
        const all = frame;
        frame = [];
        if (all.length && !left?.aborted) push(codec.serialize(all)); // the client may have left this tick
      };
      const each = (read.value as [string, string][]).map(([to, text], at) => {
        const into = (pushed: string) => {
          if (frame.length === 0) setTimeout(flush, 0);
          frame.push([to, pushed, at]);
        };
        const one = decode(to, text);
        if (!one.ok) return (into(codec.serialize(one)), Promise.resolve(true));
        return streamOne(own, hook, { address: to, value: one.value, meta, left }, into);
      });
      await Promise.all(each);
      flush(); // the last frame goes out before the stream ends (a fault is often the last word)
      return true;
    };

    return {
      run,
      json,
      delta,
      traceparent,
      given,
      routesOf,
      coding,
      asking,
      callOver,
      watchOver,
      broke,
      serveText,
      streamOne,
      streamText,
    };
  },
});

/** The protocol's steps, as one root holds them. */
export type Protocol = typeof protocol extends Resource.Handle<infer T> ? Awaited<T> : never;
