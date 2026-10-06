export declare namespace Errors {
  type Payloads = {
    StartScopeMissing: Record<string, never>;
    Cancelled: Record<string, never>;
    BadSettings: { part: string; keys: string[] };
    StreamMissing: Record<string, never>;
    StreamDenied: Record<string, never>;
    StreamDisconnected: Record<string, never>;
    WriteRejected: { message: string };
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
