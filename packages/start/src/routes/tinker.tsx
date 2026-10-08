import { createFileRoute } from "@tanstack/react-router";
import { version } from "../../package.json";

export const Route = createFileRoute("/tinker")({
  component: () => (
    <main>
      <h1>Tinker base</h1>
      <p>@tinker/start {version}</p>
    </main>
  ),
});
