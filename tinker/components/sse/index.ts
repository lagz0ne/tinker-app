import { capsule, data, operation, tag } from "@tinker/core";

import { httpBackend } from "~/components/http";
import { callInput, kept, openInput, protocol, sendInput, watchInput } from "~/components/protocol";
import type {
  Call,
  ClientSide,
  Codec,
  MetaOp,
  Protocol,
  Pushes,
  RenewOp,
  Reply,
  Streams,
  Watch,
} from "~/components/protocol";

// The SSE transport, client side: a capsule that speaks the protocol over HTTP.
// A call = POST <base>/<address> (body = text); a watch = GET <base>/<address>?text= as an event
// stream, one `data:` line per text. `meta` goes as `x-meta-*` headers. The trace: this
// transport's own span goes as `traceparent`, as OTel HTTP client instrumentation does.
// Its options are the ones SSE needs: `streams: "one"` because each stream costs one HTTP/1
// connection; `meta` as headers because a GET has no body; `renew` on a refusal (HTTP 401).
// Its HTTP goes through `httpBackend`, so a test can swap it.

type ClientConfig = {
  base: string;
  headers?: Readonly<Record<string, string>>;
  codec?: Codec;
  pushes?: Pushes;
  streams?: Streams;
  meta?: MetaOp;
  renew?: RenewOp;
};

/** Makes one SSE client. A scope can hold two (a public base and a signed base). */
export function createSse() {
  const base = tag<string>({ label: "sse.base" });
  /** Fixed headers on every request (a test's cookie). */
  const headers = tag<Readonly<Record<string, string>>>({ label: "sse.headers", default: {} });
  const keys = {
    codec: tag<Codec>({ label: "sse.codec" }).optional,
    pushes: tag<Pushes>({ label: "sse.pushes" }).optional,
    streams: tag<Streams>({ label: "sse.streams" }).optional,
    meta: tag<MetaOp>({ label: "sse.meta" }).optional,
    renew: tag<RenewOp>({ label: "sse.renew" }).optional,
  };

  // Text, one layer down: the protocol calls these. Meta goes as `x-meta-*`, the span as is.
  const send = operation({
    label: "sse.send",
    input: sendInput,
    depends: { base: base.required, headers, fetch: httpBackend, protocol },
    run: async ({ base, headers, fetch, protocol }, { input, signal, obs }) => {
      const meta = { ...input.meta, ...protocol.traceparent(obs.span) };
      const sent = Object.entries(meta).map(([k, v]) => [
        k === "traceparent" ? k : `x-meta-${k}`,
        v,
      ]);
      const reply = await fetch(`${base}/${input.address}`, {
        method: "POST",
        body: input.text,
        headers: { ...headers, ...Object.fromEntries(sent) },
        signal,
      });
      if (!reply.ok) {
        const payload = { status: reply.status };
        throw Object.assign(new Error("TransportFailed"), { kind: "TransportFailed", payload });
      }
      return reply.text();
    },
  });

  const open = operation({
    label: "sse.open",
    input: openInput,
    depends: { base: base.required, headers, fetch: httpBackend, protocol },
    run: async ({ base, headers, fetch, protocol }, { input, signal, obs }): Promise<void> => {
      const meta = { ...input.meta, ...protocol.traceparent(obs.span) };
      const sent = Object.entries(meta).map(([k, v]) => [
        k === "traceparent" ? k : `x-meta-${k}`,
        v,
      ]);
      const reply = await fetch(`${base}/${input.address}?text=${encodeURIComponent(input.text)}`, {
        headers: { ...headers, ...Object.fromEntries(sent) },
        signal,
      });
      if (!reply.ok) {
        const payload = { status: reply.status };
        throw Object.assign(new Error("TransportFailed"), { kind: "TransportFailed", payload });
      }

      let held = "";
      try {
        for await (const chunk of reply.body!.pipeThrough(new TextDecoderStream())) {
          held += chunk;
          let end: number;
          while ((end = held.indexOf("\n\n")) >= 0) {
            const line = held
              .slice(0, end)
              .split("\n")
              .find((l) => l.startsWith("data: "));
            held = held.slice(end + 2);
            if (line) input.push(JSON.parse(line.slice(6)) as string);
          }
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    },
  });

  /** What rpc and remoteData run: a value out, the reply (or the pushes) back. */
  const call = operation({
    label: "sse.call",
    input: callInput,
    run: (): Promise<Reply> => {
      throw new Error("sse: no transport here");
    },
  }) as Call;

  const watch = operation({
    label: "sse.watch",
    input: watchInput,
    run: (): Promise<void> => {
      throw new Error("sse: no transport here");
    },
  }) as Watch;

  const held = data<{ side: ClientSide; protocol: Protocol } | null>({
    label: "transport.client",
    initial: null,
  });

  /** The client: `call` and `watch`, for rpc and remoteData. */
  const client = capsule({
    label: "sse",
    config: { base: base.required, headers, ...keys },
    exports: { call, watch },
    hooks: {
      async start({ config, load, next }) {
        const p = await load(protocol, kept);
        const { codec, pushes, streams, meta, renew } = config;
        load(held, kept).set({
          protocol: p,
          side: {
            send,
            open,
            codec: p.given(codec) ?? p.json,
            pushes: p.given(pushes),
            streams: p.given(streams),
            meta: p.given(meta),
            renew: p.given(renew),
          },
        });
        return next();
      },
      run({ op, call: invocation, run, log, load, next }): unknown {
        if (op !== call && op !== watch) return next();
        const { side, protocol: p } = load(held, kept).get()!;
        const hook = { run, log, signal: invocation?.signal };
        const input = (invocation?.input ?? invocation?.rawInput) as never;
        return op === call ? p.callOver(side, hook, input) : p.watchOver(side, hook, input);
      },
    },
  });

  return {
    client: client as unknown as Omit<typeof client, never> & {
      readonly call: Call;
      readonly watch: Watch;
      (values: ClientConfig): ReturnType<typeof client>;
    },
  };
}

/** The default SSE client. */
export const sse = createSse();
