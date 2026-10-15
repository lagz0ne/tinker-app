import { createFileRoute, redirect } from "@tanstack/react-router";

import { Issues } from "@/frontend/Issues";
import { getTeamMembers } from "@/transport/issues.functions";

export const Route = createFileRoute("/issues/$teamId")({
  gcTime: 0,
  beforeLoad: async ({ context }) => {
    if ((await context.account()) === null) throw redirect({ to: "/" });

    await context.bootstrap();
  },
  loader: ({ params }) => getTeamMembers({ data: { teamId: params.teamId } }),
  component: IssuePage,
});

function IssuePage() {
  const { teamId } = Route.useParams();
  const members = Route.useLoaderData();

  return <Issues teamId={teamId} members={members} />;
}
