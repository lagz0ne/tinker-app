import { createFileRoute, redirect } from "@tanstack/react-router";

import { Teams } from "@/frontend/Teams";

export const Route = createFileRoute("/teams")({
  gcTime: 0,
  beforeLoad: async ({ context }) => {
    if ((await context.account()) === null) throw redirect({ to: "/" });

    await context.bootstrap();
  },
  component: Teams,
});
