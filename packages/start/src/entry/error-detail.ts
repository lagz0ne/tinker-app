/**
 * The error text the base's error page may show: the message in dev, and nothing in
 * production, so no server detail reaches a visitor. The server log keeps the error.
 * @param error - From TanStack's error boundary; why: the error a route threw.
 * @param dev - From import.meta.env.DEV; why: only a developer sees the text.
 */
export function errorDetail(error: unknown, dev: boolean): string | undefined {
  if (!dev) return undefined;
  return error instanceof Error ? error.message : String(error);
}
