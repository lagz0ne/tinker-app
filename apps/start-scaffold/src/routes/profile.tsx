import { createFileRoute, redirect } from "@tanstack/react-router";
import { ProfilePage } from "../frontend/App.tsx";
export const Route = createFileRoute("/profile")({
  gcTime: 0,
  beforeLoad: async ({ context }) => {
    const snapshot = await context.bootstrap();
    if (!snapshot.private) throw redirect({ to: "/" });
  },
  component: ProfilePage,
});
