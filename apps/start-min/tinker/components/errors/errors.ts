export declare namespace Errors {
  type Payloads = {
    HttpRequestFailed: {
      method: string;
      path: string;
      cause?: { name?: string; code?: string | number };
    };
    StartSessionAlreadySet: Record<string, never>;
    StartScopeMissing: Record<string, never>;
    Cancelled: Record<string, never>;

    MigrationBusy: { timeout: number };
    DatabaseFolderMissing: Record<string, never>;

    NestedTransaction: Record<string, never>;

    TransactionEnded: Record<string, never>;
    StreamMissing: Record<string, never>;
    StreamDenied: Record<string, never>;
    StreamDisconnected: Record<string, never>;
    WriteRejected: { message: string };

    BlobTooBig: { maxBytes: number };
    BlobEmpty: Record<string, never>;
    SlotMissing: Record<string, never>;
    SlotExpired: Record<string, never>;
    SlotUsed: Record<string, never>;
    SlotEmpty: Record<string, never>;
  };
  type Name = keyof Payloads;
  type Of<N extends Name> = Error & { kind: N; payload: Payloads[N] };
}

/**
 * @param kind - From a failed base action; why: choose the managed error.
 * @param payload - From that action; why: keep its failure facts.
 */
export function raise<N extends Errors.Name>(kind: N, payload: Errors.Payloads[N]): never {
  throw fail(kind, payload);
}

/**
 * The managed error itself, for a caller that rejects a promise with it instead of throwing.
 * @param kind - From a failed base action; why: choose the managed error.
 * @param payload - From that action; why: keep its failure facts.
 */
export function fail<N extends Errors.Name>(kind: N, payload: Errors.Payloads[N]): Errors.Of<N> {
  return Object.assign(new Error(kind), { kind, payload });
}

/**
 * @param error - From a caught failure; why: narrow its payload.
 * @param kind - From the caller; why: select the expected error.
 */
export function isError<N extends Errors.Name>(error: unknown, kind: N): error is Errors.Of<N> {
  return error instanceof Error && "kind" in error && error.kind === kind;
}

/** Abort consumers keep the native AbortError name and code without a per-call stack. */
export const abortReasons = {
  closed: new DOMException("The owner closed", "AbortError"),
  changed: new DOMException("The account changed", "AbortError"),
  done: new DOMException("The wait ended", "AbortError"),
  timeout: new DOMException("The deadline passed", "AbortError"),
};
