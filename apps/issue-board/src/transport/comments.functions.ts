import { createServerFn } from "@tanstack/react-start";

import { startRequests } from "~/components/requests";

import { addComment } from "@/backend/comments.server";
import { commentCommand } from "@/contracts/comments";

import { readReceipt } from "./result.server";

export const postComment = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(commentCommand)
  .handler(async ({ context, data }) =>
    readReceipt(
      await context.session.settle(addComment, {
        input: data,
        signal: context.signal,
      }),
    ),
  );
