export declare namespace Errors {
  type Payloads = {
    StartScopeMissing: Record<string, never>;
    Cancelled: Record<string, never>;
    BadSettings: { part: string; keys: string[] };
    StreamMissing: Record<string, never>;
    StreamDenied: Record<string, never>;
    StreamDisconnected: Record<string, never>;
  };
  type Name = keyof Payloads;
  type Of<N extends Name> = Error & { kind: N; payload: Payloads[N] };
}
/**
 * @param kind - From a failed base action; why: choose the managed error.
 * @param payload - From that action; why: keep its failure facts.
 */
export function raise<N extends Errors.Name>(kind: N, payload: Errors.Payloads[N]): never {
  throw Object.assign(new Error(kind), { kind, payload });
}
