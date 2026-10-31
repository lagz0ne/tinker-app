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
  /** Core's `ctx.raise`, typed to this registry: the kind picks the payload. */
  type Raise = <N extends Name>(kind: N, payload: Payloads[N]) => never;
}

/** Abort consumers keep the native AbortError name and code without a per-call stack. */
export const abortReasons = {
  closed: new DOMException("The owner closed", "AbortError"),
  changed: new DOMException("The account changed", "AbortError"),
  done: new DOMException("The wait ended", "AbortError"),
  timeout: new DOMException("The deadline passed", "AbortError"),
};
