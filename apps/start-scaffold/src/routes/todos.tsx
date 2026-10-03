import { createFileRoute, redirect } from "@tanstack/react-router";
import { Todos } from "../frontend/Todos.tsx";
export const Route = createFileRoute("/todos")({
  gcTime: 0,
  beforeLoad: async ({ context }) => {
    if ((await context.account()) === null) throw redirect({ to: "/" });
    await context.bootstrap();
  },
  component: Todos,
});
