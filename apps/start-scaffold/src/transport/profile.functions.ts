import { createServerFn } from "@tanstack/react-start";

import { startRequests } from "~/components/requests";
import { readResult } from "~/components/requests/index.server";
import { readRetry } from "~/components/sync";

import { readProfileCommand } from "@/demo";
import { readProfile, saveProfile, retryNotification } from "@/demo/index.server";

import { readReceipt } from "./result.server";

export const getProfile = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .handler(async ({ context }) =>
    readResult(await context.session.settle(readProfile, { signal: context.signal })),
  );

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
