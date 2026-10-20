export { authMail, mail, sendMail, mailStartup, enqueueMail } from "./mail.server";
export type { Mail } from "./mail.server";

export { smtpSockets } from "./sockets.server";

export { smtpUrl, mailFrom, mailSendTimeout, mailMaxSenders } from "./settings";

export { mailOutbox } from "./schema.server";

export {
  claimMailBatch,
  acknowledgeMail,
  releaseMailClaims,
  deliverMailBatch,
  outboxWake,
  mailWorkerStop,
  mailLeaseMs,
  runMailWorker,
} from "./delivery.server";
