export { authMail, mail, mailFrom, sendMail, smtpUrl, mailStartup } from "./mail.server";
export type { Mail } from "./mail.server";

export { smtpSockets } from "./sockets.server";

export { mailSendTimeout } from "./settings";

export { mailOutbox } from "./schema.server";
export { enqueueMail } from "./mail.server";

export {
  claimMailBatch,
  acknowledgeMail,
  releaseMailClaims,
  deliverMailBatch,
  outboxWake,
  mailWorkerStop,
  mailLeaseMs,
} from "./delivery.server";

export { runMailWorker } from "./delivery.server";
