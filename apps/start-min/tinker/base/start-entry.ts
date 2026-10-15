import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

/** Start owns one CSRF guard and caches the command's async options once. */
export function createStartEntry(
  read: (
    csrf: ReturnType<typeof createCsrfMiddleware>,
  ) => ReturnType<Parameters<typeof createStart>[0]>,
) {
  const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });
  let options: ReturnType<typeof read> | undefined;
  return createStart(() => (options ??= read(csrf)));
}
