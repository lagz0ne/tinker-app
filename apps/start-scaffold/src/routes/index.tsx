import { createFileRoute } from "@tanstack/react-router";
import { App } from "../frontend/App.tsx";
export const Route = createFileRoute("/")({
  gcTime: 0,
  loader: ({ context }) => context.bootstrap(),
  component: App,
});
