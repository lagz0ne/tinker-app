import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import { afterAll, expect, test } from "vite-plus/test";

import { issues } from "@/issues";
import { issueOps, membersOnly, signedIn } from "@/issues/ops.server";
import { signIn, whoMeta } from "@/issues/sign-in";
import { mail } from "@/mail";
import { memoryMail } from "@/mail/memory.server";

import { listen, wsClient as tab, wsServer as server } from "./support/ws";

// Bug: a member made a viewer stayed the assignee of their issues. An assignee is always a
// `member`, so a role change to viewer takes them off each issue of that team.

const backend = await createScope({
  capsules: [
    exits({ file: process.env.TINKER_EXITS }),
    memoryMail(),
    mail({ backend: memoryMail.deliver }),
    issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
    issues.api({ implement: issueOps, onStart: [signedIn] }),
    server.server({ path: "/rpc", services: [issues.board, issues.api] }),
  ],
}).ready;

const { bun, url } = listen(backend, [server.server]);

const ana = await createScope({
  capsules: [
    exits({ file: process.env.TINKER_EXITS }),
    tab.client({ url: `${url}/rpc`, meta: whoMeta }),
    issues.board({ read: tab.client }),
    issues.api({ remote: tab.client }),
  ],
}).ready;

ana.run(signIn, { input: { name: "ana" } });

afterAll(async () => {
  await ana.close();
  await bun.stop(true);
  await backend.close();
});

test("a member made a viewer is no longer the assignee of the team's issues", async () => {
  const teamId = "BUG";
  await ana.run(issues.api["team.create"], { input: { teamId } });
  await ana.run(issues.api["team.add"], { input: { teamId, userId: "bo", role: "member" } });
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Fix it" } });
  const [made] = backend.resolve(issues.board.issues).get();
  const id = made?.id ?? "";
  await ana.run(issues.api["issue.assign"], { input: { teamId, id, version: 1, userId: "bo" } });

  expect(
    await ana.run(issues.api["team.add"], { input: { teamId, userId: "bo", role: "viewer" } }),
  ).toEqual({ kind: "added" });
  const [now] = backend.resolve(issues.board.issues).get();
  expect(now?.assignee).toBeUndefined();
  expect(now?.version).toBe(3);
  const last = backend
    .resolve(issues.board.events)
    .get()
    .find((e) => e.version === 3);
  expect(last).toMatchObject({ by: "ana", what: "assigned" });
});
