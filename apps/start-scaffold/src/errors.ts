import type { Errors as ScaffoldErrors } from "./scaffold/errors.ts";
export declare namespace Errors {
  type Payloads = {
    NotificationFailed: Record<string, never>;
    TodoMissing: Record<string, never>;
    SignInRequired: Record<string, never>;
    BadInput: { reason: string };
    Rollback: Record<string, never>;
    AuthFailed: { message: string };
  };
  type Name = keyof Payloads | ScaffoldErrors.Name;
  type Payload<N extends Name> = N extends keyof Payloads
    ? Payloads[N]
    : N extends ScaffoldErrors.Name
      ? ScaffoldErrors.Payloads[N]
      : never;
  type Of<N extends Name> = Error & { kind: N; payload: Payload<N> };
}
export function fail<N extends Errors.Name>(kind: N, payload: Errors.Payload<N>): Errors.Of<N> {
  return Object.assign(new Error(kind), { kind, payload });
}
export function raise<N extends Errors.Name>(kind: N, payload: Errors.Payload<N>): never {
  throw fail(kind, payload);
}
export function isError<N extends Errors.Name>(error: unknown, kind: N): error is Errors.Of<N> {
  return error instanceof Error && "kind" in error && error.kind === kind;
}
