import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { rowDeliveries } from "@/backend/team-write.server";

/** A comment row the board would hand to one team stream. */
const comment = {
  id: "00000000-0000-4000-8000-000000000001",
  issueId: "00000000-0000-4000-8000-000000000002",
  authorId: "ada",
  body: "Ready for review.",
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** An issue row the board would hand to one team stream. */
const issue = {
  id: "00000000-0000-4000-8000-000000000003",
  teamId: "00000000-0000-4000-8000-000000000004",
  teamKey: "ENG",
  number: 1,
  title: "Ship it",
  description: "",
  state: "todo",
  priority: 2,
  assigneeId: null,
  creatorId: "ada",
  rank: "a0",
  version: 1,
};

test("a comment change reaches every member and its result reaches only the actor", () => {
  const root = createScope();
  try {
    expect(
      root.run(rowDeliveries, {
        rawInput: {
          members: [{ id: "ada" }, { id: "grace" }],
          change: { kind: "comment.add", comment },
          actorId: "ada",
        },
      }),
    ).toEqual([
      {
        stream: "ada",
        payloads: [
          { kind: "change", change: { kind: "comment.add", comment } },
          { kind: "result", result: { kind: "complete", action: "comment" } },
        ],
      },
      { stream: "grace", payloads: [{ kind: "change", change: { kind: "comment.add", comment } }] },
    ]);
  } finally {
    void root.close();
  }
});

test("an issue change names the issue action, and a non-actor member gets no result", () => {
  const root = createScope();
  try {
    expect(
      root.run(rowDeliveries, {
        rawInput: {
          members: [{ id: "grace" }, { id: "ada" }],
          change: { kind: "issue.upsert", issue },
          actorId: "ada",
        },
      }),
    ).toEqual([
      { stream: "grace", payloads: [{ kind: "change", change: { kind: "issue.upsert", issue } }] },
      {
        stream: "ada",
        payloads: [
          { kind: "change", change: { kind: "issue.upsert", issue } },
          { kind: "result", result: { kind: "complete", action: "issue" } },
        ],
      },
    ]);
  } finally {
    void root.close();
  }
});

test("a removed issue also names the issue action, once per locked stream", () => {
  const root = createScope();
  try {
    const delivery = {
      stream: "ada",
      payloads: [
        { kind: "change", change: { kind: "issue.remove", id: issue.id } },
        { kind: "result", result: { kind: "complete", action: "issue" } },
      ],
    };

    expect(
      root.run(rowDeliveries, {
        rawInput: {
          members: [{ id: "ada" }, { id: "ada" }],
          change: { kind: "issue.remove", id: issue.id },
          actorId: "ada",
        },
      }),
    ).toEqual([delivery, delivery]);
  } finally {
    void root.close();
  }
});

test("an empty member list fans out to nothing", () => {
  const root = createScope();
  try {
    expect(
      root.run(rowDeliveries, {
        rawInput: {
          members: [],
          change: { kind: "comment.add", comment },
          actorId: "ada",
        },
      }),
    ).toEqual([]);
  } finally {
    void root.close();
  }
});

test("the input schema refuses a change one board row never sends", () => {
  const root = createScope();
  try {
    for (const change of [
      { kind: "counter", value: 1 },
      { kind: "teams", rows: [] },
    ]) {
      const refused = root.settle(rowDeliveries, {
        rawInput: { members: [{ id: "ada" }], change, actorId: "ada" },
      });

      expect(refused).toMatchObject({
        status: "failed",
        error: { kind: "DataValidationFailed", payload: { label: "streams.rowDeliveries" } },
      });
    }
  } finally {
    void root.close();
  }
});
