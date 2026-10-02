export declare namespace Errors {
  type Payloads = {
    StreamMissing: Record<string, never>;
    StreamDenied: Record<string, never>;
    StreamDisconnected: Record<string, never>;
    RetryNotAvailable: Record<string, never>;
    WriteRejected: { message: string };
    StartScopeMissing: Record<string, never>;
    Cancelled: Record<string, never>;
    BadSettings: { keys: string[] };
  };
  type Name = keyof Payloads;
  type Of<N extends Name> = Error & { kind: N; payload: Payloads[N] };
}
export function fail<N extends Errors.Name>(kind: N, payload: Errors.Payloads[N]): Errors.Of<N> {
  return Object.assign(new Error(kind), { kind, payload });
}
export function raise<N extends Errors.Name>(kind: N, payload: Errors.Payloads[N]): never {
  throw fail(kind, payload);
}
export function isError<N extends Errors.Name>(error: unknown, kind: N): error is Errors.Of<N> {
  return error instanceof Error && "kind" in error && error.kind === kind;
}
