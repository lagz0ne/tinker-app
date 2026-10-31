import { createServerFn } from "@tanstack/react-start";

import { startRequests } from "~/components/requests";
import { readRetry } from "~/components/sync";

import { readProfileCommand } from "@/demo/contracts/commands";

import { profileRead, profileReceipt, retryReceipt } from "./result.server";

export const getProfile = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .handler(async ({ context }) => context.session.run(profileRead));

export const updateProfile = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(readProfileCommand)
  .handler(async ({ context, data }) => context.session.run(profileReceipt, { input: data }));

export const retryProfileNotification = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(readRetry)
  .handler(async ({ context, data }) => context.session.run(retryReceipt, { input: data }));
