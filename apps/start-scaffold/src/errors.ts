import type { Errors as BaseErrors } from "@tinker/start";

export declare namespace Errors {
  type Payloads = {
    NotificationFailed: Record<string, never>;
    TodoMissing: Record<string, never>;
    SignInRequired: Record<string, never>;
    BadInput: { reason: string };
    Rollback: Record<string, never>;
    RetryNotAvailable: Record<string, never>;
    StoredDataInvalid: Record<string, never>;
    AuthFailed: { message: string };
  };
  type Name = keyof Payloads | BaseErrors.Name;
  type Payload<N extends Name> = N extends keyof Payloads
    ? Payloads[N]
    : N extends BaseErrors.Name
      ? BaseErrors.Payloads[N]
      : never;
  type Of<N extends Name> = Error & { kind: N; payload: Payload<N> };
}

/**
 * @param kind - From the failing caller; why: choose the managed error.
 * @param payload - From the failing caller; why: keep facts for that error.
 */
export function raise<N extends Errors.Name>(kind: N, payload: Errors.Payload<N>): never {
  throw Object.assign(new Error(kind), { kind, payload });
}

/**
 * @param error - From a caught failure; why: narrow its payload.
 * @param kind - From the caller; why: select the expected error.
 */
export function isError<N extends Errors.Name>(error: unknown, kind: N): error is Errors.Of<N> {
  return error instanceof Error && "kind" in error && error.kind === kind;
}
