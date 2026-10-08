import { createFileRoute } from "@tanstack/react-router";
import { App } from "../frontend/App";

export const Route = createFileRoute("/")({
  gcTime: 0,
  loader: async ({ context }) => {
    await context.bootstrap();
  },
  component: App,
});
