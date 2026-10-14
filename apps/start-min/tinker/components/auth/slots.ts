import { tag } from "@tinker/core";

/** The command binds its owned mail queue; auth never owns delivery. */
export const sendAuthMail = tag<(message: { to: string; subject: string; text: string }) => void>({
  label: "auth.sendMail",
});

/** The command binds the post-commit account notice; auth never imports sync. */
export const sessionDeleted = tag<(accountId: string) => Promise<void>>({
  label: "auth.sessionDeleted",
});
