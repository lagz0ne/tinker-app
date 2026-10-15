import type { ErrorComponentProps } from "@tanstack/react-router";

import { ErrorDetails } from "./panics";

/**
 * A production page hides error text; the server reports its route failure to the console.
 */
export function TinkerError({ error }: ErrorComponentProps) {
  if (import.meta.env.SSR) console.error("tinker: a route failed on the server:", error);
  return <ErrorDetails error={error} dev={import.meta.env.DEV} />;
}

/** The base's 404 page; a route's own notFoundComponent, or src/router.ts, replaces it. */
export function TinkerNotFound() {
  return (
    <main>
      <h1>Not found</h1>
    </main>
  );
}
