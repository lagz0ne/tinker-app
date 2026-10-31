import { createServerFn } from "@tanstack/react-start";

import { startRequests } from "~/components/requests";
import { cancelledCall } from "~/components/requests/index.server";
import { readRetry } from "~/components/sync";

import { readProfile, saveProfile, retryNotification } from "@/demo/backend/profile.server";
import { readProfileCommand } from "@/demo/contracts/commands";

import { readReceipt } from "./result.server";

export const getProfile = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .handler(async ({ context }) => {
    const result = await context.session.settle(readProfile, { signal: context.signal });
    if (result.status === "failed") throw result.error;
    if (result.status === "cancelled") return context.session.run(cancelledCall);
    return result.value;
  });

export const updateProfile = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(readProfileCommand)
  .handler(async ({ context, data }) =>
    readReceipt(await context.session.settle(saveProfile, { input: data, signal: context.signal })),
  );

export const retryProfileNotification = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(readRetry)
  .handler(async ({ context, data }) =>
    readReceipt(
      await context.session.settle(retryNotification, { input: data, signal: context.signal }),
    ),
  );
