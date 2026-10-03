import { operation, resource } from "@tinker/core";
import { auth, requestHeaders, database } from "@/lib/tinker.server";
import { notifications } from "./notifications.ts";
import { backendStop, requestStop } from "./lifetime.ts";
import { streamRequest, streamCursor } from "../protocol.ts";
import type { Stream } from "../protocol.ts";
import type { Sync } from "../sync.ts";
import { raise } from "../errors.ts";
/** Cookie caches and session refresh are disabled on this long-lived request. */
const liveAccount = operation({
  label: "sync.liveAccount",
  depends: { auth, headers: requestHeaders },
  run: async ({ auth, headers }) =>
    (
      await auth.api.getSession({
        headers,
        query: { disableCookieCache: true, disableRefresh: true },
      })
    )?.user.id ?? null,
});
/** The request resource owns the returned body, including pulls after the opening operation ends. */
export const eventStream = resource({
  label: "sync.stream",
  target: "session",
  depends: { database, notifications, account: liveAccount, backendStop, requestStop },
  factory: async ({ database, notifications, account, backendStop, requestStop }, ctx) => {
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, backendStop, requestStop, ctx.signal]);
    let subscription: Awaited<ReturnType<typeof notifications.subscribe>> | undefined;
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    let ended = false;
    const close = () => {
      if (ended) return;
      ended = true;
      stop.abort();
      subscription?.close();
      output?.close();
    };
    signal.addEventListener("abort", close, { once: true });
    ctx.defer(() => {
      close();
      signal.removeEventListener("abort", close);
    });
    return {
      async open(initial: Stream.Cursor) {
        subscription = await notifications.subscribe(close);
        if (signal.aborted) {
          subscription.close();
          raise("Cancelled", {});
        }
        const changes = subscription;
        const openingWake = changes.revision();
        const initialAccount = await account.run();
        if (initial.private && initial.private.accountId !== initialAccount)
          raise("StreamDenied", {});
        const [{ and, or, eq, gt, asc }, { event }] = await Promise.all([
          import("drizzle-orm"),
          import("./sync.schema.ts"),
        ]);
        const cursor = { ...initial, private: initial.private ? { ...initial.private } : null };
        const lease = ctx.clock.currentTimeMillis() + 30_000;
        const encoder = new TextEncoder();
        let afterWake = -1;
        const expectedAccount = cursor.private?.accountId ?? null;
        let authorizedWake = initialAccount === expectedAccount ? openingWake : -1;
        let greeted = false;
        const delivery = {
          alive() {
            if (changes.ended() || ctx.clock.currentTimeMillis() >= lease) close();
            return !ended;
          },
          async authorize(heartbeat = false) {
            const wake = changes.revision();
            if (!heartbeat && wake === authorizedWake) return !ended;
            const current = await account.run();
            authorizedWake = wake;
            if (ended) return false;
            if (current === expectedAccount) return true;
            output?.enqueue(encoder.encode('event: account\ndata: {"kind":"account-change"}\n\n'));
            close();
            return false;
          },
          frame(rows: Sync.Envelope[]) {
            for (const row of rows) {
              if (row.stream === "public") cursor.public = row.revision;
              else if (cursor.private) cursor.private.revision = row.revision;
            }
            return encoder.encode(
              `event: changes\nid: ${JSON.stringify(cursor)}\ndata: ${JSON.stringify({ kind: "changes", events: rows })}\n\n`,
            );
          },
          async replay() {
            const wake = changes.revision();
            if (wake === afterWake) return;
            const rows = await database
              .select()
              .from(event)
              .where(
                or(
                  and(eq(event.stream, "public"), gt(event.revision, cursor.public)),
                  cursor.private
                    ? and(
                        eq(event.stream, cursor.private.accountId),
                        gt(event.revision, cursor.private.revision),
                      )
                    : undefined,
                ),
              )
              .orderBy(asc(event.stream), asc(event.revision))
              .limit(100);
            if (!(await delivery.authorize())) return;
            if (rows.length) return delivery.frame(rows);
            afterWake = wake;
          },
          async wait() {
            if (ended || changes.revision() !== afterWake) return;
            if (!greeted) {
              greeted = true;
              return encoder.encode(": connected\n\n");
            }
            const waiting = new AbortController();
            const waitingSignal = AbortSignal.any([signal, waiting.signal]);
            try {
              const outcome = await Promise.race([
                changes.wait(afterWake, waitingSignal).then(() => "changed"),
                ctx.clock.sleep(10_000, waitingSignal).then(() => "heartbeat"),
              ]);
              if (outcome === "heartbeat" && (await delivery.authorize(true)))
                return encoder.encode(": heartbeat\n\n");
            } finally {
              waiting.abort();
            }
          },
          async next(): Promise<Uint8Array | undefined> {
            while (delivery.alive()) {
              if (!(await delivery.authorize())) return;
              const frame = await delivery.replay();
              if (frame) return frame;
              const heartbeat = await delivery.wait();
              if (heartbeat && (await delivery.authorize())) return heartbeat;
            }
          },
        };
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              output = controller;
              if (ended) controller.close();
              else if (signal.aborted) close();
            },
            async pull(controller) {
              try {
                const frame = await delivery.next();
                if (frame && !ended) controller.enqueue(frame);
              } catch (error) {
                if (signal.aborted) {
                  close();
                  return;
                }
                ended = true;
                stop.abort();
                changes.close();
                controller.error(error);
              }
            },
            cancel() {
              output = undefined;
              close();
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(body, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          },
        });
      },
    };
  },
});
export const openSync = operation({
  label: "sync.open",
  input: (raw: unknown) => {
    const { search, lastEventId } = streamRequest.parse(raw);
    const supplied = lastEventId || new URLSearchParams(search).get("cursor");
    return streamCursor.parse(supplied ? JSON.parse(supplied) : { public: 0, private: null });
  },
  depends: { stream: eventStream },
  run: async ({ stream }, ctx) => stream.open(ctx.input),
});
