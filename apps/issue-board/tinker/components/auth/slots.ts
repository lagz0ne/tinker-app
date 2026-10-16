import type { Scope } from "@tinker/core";
import { tag } from "@tinker/core";

/** The command binds its owned mail queue; auth never owns delivery. */
export const sendAuthMail = tag<
  (message: { to: string; subject: string; text: string }, context: Scope.ExtensionCtx) => void
>({
  label: "auth.sendMail",
});

/** The command binds the post-commit account notice; auth never imports sync. */
export const sessionDeleted = tag<
  (accountId: string, context: Scope.ExtensionCtx) => Promise<void>
>({
  label: "auth.sessionDeleted",
});

/** Idempotent account initialization on user creation and every new session. */
export const userCreated = tag<(accountId: string, context: Scope.ExtensionCtx) => Promise<void>>({
  label: "auth.userCreated",
});
