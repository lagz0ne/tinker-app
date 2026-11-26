import { tag } from "@tinkered/core";

// The mail seam (ADR 0113): mail is an outside effect, so it reaches the server only through this
// tag. The unit that sends names `mailer.required` in its `depends`; it never opens a socket.

/** Sends one mail. It answers when the mail has left. It may throw (mail is down), and it may
 * never answer (mail hangs). */
export type Mailer = {
  send: (to: string, subject: string, body: string) => Promise<void>;
};

/** The server's mailer. The cmd binds it; a test binds a fake:
 * `createScope({ tags: [mailer(fake)] })`. */
export const mailer = tag<Mailer>({ label: "issues.mailer" });
