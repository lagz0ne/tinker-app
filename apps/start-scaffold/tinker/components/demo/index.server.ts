export {
  auth,
  authSettings,
  principal,
  currentUser,
  readAccount,
} from "~/components/demo/backend/auth.server";

export { incrementCounter } from "~/components/demo/backend/counter.server";

export type { Database } from "~/components/demo/backend/database.server";

export {
  database,
  databaseSetup,
  databaseUrl,
  migrate,
} from "~/components/demo/backend/database.server";

export type { Mail } from "~/components/mail/index.server";

export { authMail, mail, mailFrom, sendMail, smtpUrl } from "~/components/mail/index.server";

export {
  readProfile,
  saveProfile,
  retryNotification,
} from "~/components/demo/backend/profile.server";

export { settings } from "~/components/demo/backend/settings.server";

export {
  bootstrap,
  bootstrapPublic,
  bootstrapPrivate,
  replayPublic,
  replayPrivate,
} from "~/components/demo/backend/sync.server";

export { listTodos, changeTodo } from "~/components/demo/backend/todos.server";
