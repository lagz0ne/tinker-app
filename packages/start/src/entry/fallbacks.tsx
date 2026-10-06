import type { ErrorComponentProps } from "@tanstack/react-router";
import { errorDetail } from "./error-detail.ts";

/**
 * The base's error page: a production page shows no error text, and the server log gets the
 * error. It logs to the console because this POC base has no telemetry part yet.
 */
export function TinkerError({ error }: ErrorComponentProps) {
  if (import.meta.env.SSR) console.error("tinker: a route failed on the server:", error);
  const detail = errorDetail(error, import.meta.env.DEV);
  return (
    <main>
      <h1>Something went wrong</h1>
      {detail !== undefined && <pre>{detail}</pre>}
    </main>
  );
}

/** The base's 404 page; a route's own notFoundComponent, or src/router.ts, replaces it. */
export function TinkerNotFound() {
  return (
    <main>
      <h1>Not found</h1>
    </main>
  );
}
