import { createFileRoute, redirect } from "@tanstack/react-router";
import { Todos } from "../frontend/Todos.tsx";
export const Route = createFileRoute("/todos")({
  gcTime: 0,
  beforeLoad: async ({ context }) => {
    const snapshot = await context.bootstrap();
    if (!snapshot.private) throw redirect({ to: "/" });
  },
  component: Todos,
});
