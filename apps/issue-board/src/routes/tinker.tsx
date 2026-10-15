import { createFileRoute } from "@tanstack/react-router";

import { baseVersion } from "~/components/health";

export const Route = createFileRoute("/tinker")({
  component: () => (
    <main>
      <h1>Tinker base</h1>
      <p>@tinker/start {baseVersion}</p>
    </main>
  ),
});
