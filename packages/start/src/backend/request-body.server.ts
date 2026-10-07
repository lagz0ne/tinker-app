import { resource } from "@tinker/core";
import { backendStop, requestStop } from "./lifetime";

/** The request owns the reader; its route borrows it until all body checks finish. */
export const requestBody = resource({
  label: "request.body",
  target: "session",
  depends: { backendStop, requestStop },
  factory: ({ backendStop, requestStop }, ctx) => {
    const signal = AbortSignal.any([backendStop, requestStop, ctx.signal]);
    let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= reader?.cancel();
    };
    signal.addEventListener("abort", cancel, { once: true });
    const release = async () => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) cancel();
      await cancellation;
      reader?.releaseLock();
      reader = undefined;
    };
    ctx.defer(release);
    return {
      signal,
      open(body: ReadableStream<Uint8Array<ArrayBuffer>>) {
        reader = body.getReader();
        if (signal.aborted) cancel();
        return reader;
      },
      release,
    };
  },
});
