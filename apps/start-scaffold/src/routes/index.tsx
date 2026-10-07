import { createFileRoute } from "@tanstack/react-router";
import { App } from "../frontend/App";
export const Route = createFileRoute("/")({
  gcTime: 0,
  loader: ({ context }) => context.bootstrap(),
  component: App,
});
