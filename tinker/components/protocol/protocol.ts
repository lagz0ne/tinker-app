import { resource } from "@tinker/core";
import type { Observe, Operation, Resource } from "@tinker/core";

import type { Body, Codec, Open, Reply, Send, Service } from "./wire";

// The protocol: the reply envelope, the fault set, the codec use and the route table. Fixed: any transport carries it (glossary "protocol", ADR 0048). It is not a capsule.
// Each transport (ws, memory) is one client and one server capsule that speaks it, as each
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
  readonly meta?: MetaOp;
  readonly renew?: RenewOp;
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

/** The renew in flight, per client side. */
const renewing = new WeakMap<object, Promise<boolean>>();

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
      input: { address: string; value: unknown; meta: Record<string, string>; body?: Body },
    ): Promise<Reply> => {
      const { encode, replyOf } = coding(own.codec, "client", hook.log);
      const { address, body: bytes } = input;
      const { meta, metaNow, renewed } = await asking(own, hook, input.meta);
      const body = encode(address, input.value);
      if (!body.ok) return body; // nothing is sent

      const ask = async (m: Record<string, string>): Promise<Reply> => {
        const text = await run<string>(hook, own.send, {
          input: { address, text: body.value, meta: m, ...(bytes ? { body: bytes } : {}) },
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
      const { encode, replyOf } = coding(own.codec, "client", hook.log);
      const { address, push: up } = input;
      const { signal } = hook;
      const { meta, renewed } = await asking(own, hook, input.meta);
      const body = encode(address, input.value);
      if (!body.ok) return up(body); // nothing is sent

      const got = (text: string) => {
        const reply = replyOf(address, text);
        // A refused push starts a renew; the watch's own retry then opens with fresh meta.
        if (!reply.ok && reply.kind === "refused") void renewed(reply.payload, meta);
        up(reply);
      };

      return run<void>(hook, own.open, {
        input: { address, text: body.value, meta, push: got },
        signal,
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
      input: { address: string; text: string; meta: Record<string, string>; body?: Body },
    ): Promise<string | null> => {
      const { codec, routes } = own;
      const { decode, answerText } = coding(codec, "server", hook.log);
      const { address, meta, body } = input;
      const read = decode(address, input.text);
      if (!read.ok) return codec.serialize(read);
      const service = routes.get(address);
      if (!service) return null; // no one has this address: the transport says 404

      const reply = await run<Reply | null>(hook, service.answer, {
        input: { address, value: read.value, meta, ...(body ? { body } : {}) },
        signal: hook.signal,
      }).catch(broke(hook.log, address));

      return reply === null ? null : answerText(address, reply);
    };

    /** Server: one watched address, its pushes as reply texts, until the client leaves. */
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
      const { codec, routes } = own;
      const { decode, answerText } = coding(codec, "server", hook.log);
      const { address, meta, push, left } = input;
      const read = decode(address, input.text);
      if (!read.ok) return (push(codec.serialize(read)), true);
      const send = (reply: Reply) => push(answerText(address, reply));
      const service = routes.get(address);
      // No one has this address. Over its own stream the client would see only an end, so the
      // stream says it: link, as a 404 on a call.
      if (!service) return (send(link), false);

      return run<boolean>(hook, service.stream, {
        input: { address, value: read.value, meta, left, push: send },
      }).catch((error) => (send(broke(hook.log, address)(error)), true));
    };

    return {
      run,
      json,
      traceparent,
      given,
      routesOf,
      coding,
      asking,
      callOver,
      watchOver,
      broke,
      serveText,
      streamText,
    };
  },
});

/** The protocol's steps, as one root holds them. */
export type Protocol = typeof protocol extends Resource.Handle<infer T> ? Awaited<T> : never;
