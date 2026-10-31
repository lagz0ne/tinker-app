import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { requestStop } from "~/components/requests";

import { addComment } from "@/backend/comments.server";
import { changeIssue, listTeamMembers } from "@/backend/issues.server";
import { changeTeam } from "@/backend/teams.server";
import { greetRead } from "@/transport/greet.server";
import {
  commentReceipt,
  issueReceipt,
  teamMembersRead,
  teamReceipt,
} from "@/transport/result.server";

const executionId = "10000000-0000-4000-8000-000000000001";
const teamId = "20000000-0000-4000-8000-000000000002";
const issueId = "30000000-0000-4000-8000-000000000003";

test("each board write hands its input to the write and answers with the receipt", async () => {
  const seen: unknown[] = [];
  const accept = async (_deps: unknown, ctx: { input: unknown }) => {
    seen.push(ctx.input);
    return { executionId };
  };
  const root = createScope({
    presets: [preset(addComment, accept), preset(changeIssue, accept), preset(changeTeam, accept)],
  });
  const request = root.createSession({ tags: [requestStop(new AbortController().signal)] });
  const accepted = { kind: "accepted", executionId };
  const comment = { executionId, comment: { teamId, issueId, body: "Looks good" } };
  const issue = {
    executionId,
    change: { kind: "remove" as const, teamId, id: issueId, version: 1 },
  };
  const team = { executionId, change: { kind: "create" as const, key: "ENG", name: "Eng" } };

  expect(await request.run(commentReceipt, { input: comment })).toEqual(accepted);
  expect(await request.run(issueReceipt, { input: issue })).toEqual(accepted);
  expect(await request.run(teamReceipt, { input: team })).toEqual(accepted);
  expect(seen).toEqual([comment, issue, team]);
  await request.close();
});

test("the board reads return their value, and raise Cancelled once the request stopped", async () => {
  const members = [{ id: "ada", name: "Ada", email: "ada@example.test" }];
  const root = createScope({
    presets: [
      preset(listTeamMembers, async (_deps, { input }) => {
        expect(input).toEqual({ teamId });
        return members;
      }),
    ],
  });
  const open = root.createSession({ tags: [requestStop(new AbortController().signal)] });
  expect(await open.run(teamMembersRead, { input: { teamId } })).toEqual(members);
  expect(await open.run(greetRead)).toEqual({ text: "Hello, world." });
  await open.close();

  const stop = new AbortController();
  stop.abort();
  const stopped = root.createSession({ tags: [requestStop(stop.signal)] });
  for (const [settled, label] of [
    [await stopped.settle(teamMembersRead, { input: { teamId } }), "transport.teamMembers"],
    [await stopped.settle(greetRead), "transport.greet"],
  ] as const) {
    expect(settled).toMatchObject({
      status: "failed",
      kind: "error",
      error: expect.objectContaining({ kind: "Cancelled", payload: {} }),
      origin: { label },
    });
  }
  await stopped.close();
  expect((await root.close({ graceful: true })).status).toBe("success");
});
