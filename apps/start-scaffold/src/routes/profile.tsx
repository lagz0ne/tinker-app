import { createFileRoute, redirect } from "@tanstack/react-router";
import { ProfilePage } from "../frontend/App.tsx";
export const Route = createFileRoute("/profile")({
  gcTime: 0,
  beforeLoad: async ({ context }) => {
    if ((await context.account()) === null) throw redirect({ to: "/" });
    await context.bootstrap();
  },
  component: ProfilePage,
});
