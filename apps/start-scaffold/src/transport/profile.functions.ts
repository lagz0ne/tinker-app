import { readRetry } from "../contracts/sync";
import { createServerFn } from "@tanstack/react-start";
import { readProfileCommand } from "../contracts/commands";
import { readProfile, saveProfile, retryNotification } from "../backend/index.server";
import { startRequests } from "@tinker/start";
import { readResult } from "@tinker/start/server";
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
