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
    McpNotInstalled: Record<string, never>;

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
    BlobNotBytes: Record<string, never>;
    SlotMissing: Record<string, never>;
    SlotExpired: Record<string, never>;
    SlotUsed: Record<string, never>;
    SlotEmpty: Record<string, never>;
    Refused: { message: string };
  };
  type Name = keyof Payloads;
  type Of<N extends Name> = Error & { kind: N; payload: Payloads[N] };
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
