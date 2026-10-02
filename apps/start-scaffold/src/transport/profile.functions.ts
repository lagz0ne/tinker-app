import { readRetry } from "../contracts/sync.ts";
import { createServerFn } from "@tanstack/react-start";
import { readProfileCommand } from "../contracts/commands.ts";
import { readProfile, saveProfile, retryNotification } from "../backend/index.ts";
import { getBackend } from "../scaffold/backend/entry.server.ts";
import { startRequests } from "../scaffold/start.ts";
import { readResult } from "../scaffold/backend/result.server.ts";
import { readReceipt } from "./result.server.ts";
export const getProfile = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .handler(async ({ context }) =>
    readResult(await context.session.settle(readProfile, { signal: context.signal })),
  );
export const updateProfile = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .inputValidator(readProfileCommand)
  .handler(async ({ context, data }) =>
    readReceipt(await context.session.settle(saveProfile, { input: data, signal: context.signal })),
  );
export const getBackendSpans = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .handler(async () => (import.meta.env.DEV ? (await getBackend()).readHistory() : []));
export const retryProfileNotification = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .inputValidator(readRetry)
  .handler(async ({ context, data }) =>
    readReceipt(
      await context.session.settle(retryNotification, { input: data, signal: context.signal }),
    ),
  );
