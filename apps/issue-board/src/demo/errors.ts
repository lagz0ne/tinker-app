import type { Errors as BaseErrors } from "~/components/errors";

export declare namespace Errors {
  type Payloads = {
    TeamChanged: Record<string, never>;
    IssueConflict: Record<string, never>;
    InvalidPosition: Record<string, never>;
    IssueMissing: Record<string, never>;
    InvalidAssignee: Record<string, never>;
    NotTeamMember: Record<string, never>;
    TeamKeyTaken: Record<string, never>;
    TeamAdminRequired: Record<string, never>;
    UserNotFound: Record<string, never>;
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
  /** Core's `ctx.raise`, typed to this registry: the kind picks the payload. */
  type Raise = <N extends Name>(kind: N, payload: Payload<N>) => never;
}
