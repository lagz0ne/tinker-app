import type { ErrorComponentProps } from "@tanstack/react-router";

import { ErrorDetails } from "./panics";

/** A production page hides error text. */
export function TinkerError({ error }: ErrorComponentProps) {
  return <ErrorDetails error={error} dev={process.env.NODE_ENV !== "production"} />;
}

/** The base's 404 page; a route's own notFoundComponent replaces it. */
export function TinkerNotFound() {
  return (
    <main>
      <h1>Not found</h1>
    </main>
  );
}
