import type { ErrorComponentProps } from "@tanstack/react-router";

import { ErrorDetails } from "./panics";

/**
 * A production page hides error text; the server reports its route failure to the console.
 */
export function TinkerError({
  error,
  dev,
  server,
}: ErrorComponentProps & { dev: boolean; server: boolean }) {
  if (server) console.error("tinker: a route failed on the server:", error);
  return <ErrorDetails error={error} dev={dev} />;
}

/** The base's 404 page; a route's own notFoundComponent, or the router command, replaces it. */
export function TinkerNotFound() {
  return (
    <main>
      <h1>Not found</h1>
    </main>
  );
}
