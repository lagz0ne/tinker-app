import { createServerFn } from "@tanstack/react-start";

import { startRequests } from "~/components/requests";

import { commentCommand } from "@/contracts/comments";

import { commentReceipt } from "./result.server";

export const postComment = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(commentCommand)
  .handler(async ({ context, data }) => context.session.run(commentReceipt, { input: data }));
