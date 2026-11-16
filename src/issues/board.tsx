import { Link, useNavigate } from "@tanstack/react-router";
import type { PartState, RemoteFault } from "@tinkered/core";
import { useData, useRun } from "@tinkered/react";
import { memo } from "react";
import { z } from "zod";

import { type Issue, issueApi, issueBoard, states } from "./contract";
import { me as signedAs, signIn } from "./sign-in";

// The issue board's pages. No state of their own: each reads a keyed part with `useData` and asks
// the server with `useRun`; the server's write comes back as a signal for that part alone.

/** `/issues`: who you are, and which team to open (it is made if nobody has it yet). */
export function IssuesHome() {
  const signedIn = useRun(signIn);
  const navigate = useNavigate();
  const open = useRun(issueApi["team.create"], {
    onSuccess: (_, call) =>
      call.input && void navigate({ to: "/issues/$team", params: { team: call.input.teamId } }),
  });
  const me = useData(signedAs);

  return (
    <main>
      <h1>Issues</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const name = new FormData(event.currentTarget).get("name");
          if (typeof name === "string") signedIn.run({ input: { name } });
        }}
      >
        <input name="name" aria-label="Your name" defaultValue={me} />
        <button type="submit">Sign in</button>
      </form>
      {me && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const teamId = new FormData(event.currentTarget).get("team");
            if (typeof teamId === "string") {
              open.run({ input: { teamId: teamId.trim().toUpperCase() } });
            }
          }}
        >
          <input name="team" aria-label="Team key" placeholder="ENG" />
          <button type="submit">Open team</button>
        </form>
      )}
    </main>
  );
}

/** A refusal's payload, when the reader is not in the team. */
const notMember = z.object({ notMember: z.string() });

/** A call's answer, as the page gets it. */
type Out<K extends "team.add" | "issue.create" | "issue.move" | "comment.add"> = Awaited<
  ReturnType<(typeof issueApi)[K]["run"]>
>;

/** What a move's answer says. Every kind has its case: a new kind fails here. */
function Moved({ out }: { out: Out<"issue.move"> | undefined }) {
  switch (out?.kind) {
    case undefined:
    case "moved":
      return null;
    case "stale":
      return <small role="status">Changed by someone else.</small>;
    case "gone":
      return <small role="status">This issue is gone.</small>;
  }
}

/** What an add's answer says: an issue, a member or a comment. */
function Added({ out }: { out: Out<"team.add" | "issue.create" | "comment.add"> | undefined }) {
  switch (out?.kind) {
    case undefined:
    case "created":
    case "added":
      return null;
    case "gone":
      return <small role="status">That is gone, or you are not in this team.</small>;
  }
}

/** `link`: no answer came. A read is asked again by itself. A call is not: when it left, the
 * server may have done it, so the person looks first. */
function NoAnswer({ read, sent }: { read?: boolean; sent?: boolean }) {
  if (read) return <p role="status">Offline. Trying again.</p>;

  return (
    <p role="status">
      {sent === false
        ? "Offline. Nothing was sent. Try again."
        : "No answer. It may be saved. Look, then try again."}
    </p>
  );
}

/** A fault, said by who spoke (Core 0.17.5): the server's answer, or this side with no answer.
 * - `refused`, `missing`: the server answered, and the same ask gives the same answer.
 * - `link`: no answer. A read is asked again by itself. A call is not: `sent` says if it left.
 *   When it did, the server may have done it, so the person looks first.
 * - the rest is a bug: it shows the trace id as a ref. The cause is in that trace, never here. */
function Fault({ fault, read }: { fault: RemoteFault; read?: boolean }) {
  const { fault: kind, payload, sent, traceId } = fault;
  if (kind === "link") return <NoAnswer read={read} sent={sent} />;
  if (kind === "missing") return <p role="alert">This page is old. Load it again.</p>;

  const team = notMember.safeParse(payload).data?.notMember;
  if (kind === "refused") {
    return <p role="alert">{team ? `You are not in team ${team}.` : "Sign in first."}</p>;
  }

  return <p role="alert">{`Something broke.${traceId ? ` Ref ${traceId.slice(0, 8)}` : ""}`}</p>;
}

/** A call's error: shown when it is a fault of the board's api. */
function CallFault({ error }: { error: unknown }) {
  return issueApi.fault.is(error) ? <Fault fault={error} /> : null;
}

/** A part that is not ready: not read yet, or a fault that stands. A broken link heals by
 * itself. Any other fault is the server's answer, so it waits for the person: "Try again" asks
 * for the part once more. */
function Waiting({ state, again }: { state: PartState | undefined; again: () => void }) {
  if (state?.status !== "fault") return <p role="status">Loading.</p>;

  return (
    <>
      <Fault fault={state.fault} read />
      {state.fault.fault !== "link" && (
        <button type="button" onClick={again}>
          Try again
        </button>
      )}
    </>
  );
}

/** `/issues/$team`: the team's issues in four lanes, live; the open thread beside them. */
export function Board({ teamId }: { teamId: string }) {
  const part = issueBoard.issues.where({ teamId });
  const list = useData(part);
  const state = useData(issueBoard.status(part));
  const again = useRun(issueBoard.invalidate);
  const create = useRun(issueApi["issue.create"]);
  const add = useRun(issueApi["team.add"]);
  if (state?.status !== "ready") {
    return (
      <main>
        <Waiting state={state} again={() => again.run({ input: { issues: { teamId } } })} />
      </main>
    );
  }

  return (
    <main>
      <h1>{teamId}</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const title = new FormData(event.currentTarget).get("title");
          if (typeof title === "string") create.run({ input: { teamId, title } });
          event.currentTarget.reset();
        }}
      >
        <input name="title" aria-label="New issue" placeholder="What is wrong?" />
        <button type="submit">Add issue</button>
      </form>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const userId = new FormData(event.currentTarget).get("user");
          if (typeof userId === "string") add.run({ input: { teamId, userId } });
          event.currentTarget.reset();
        }}
      >
        <input name="user" aria-label="Add member" placeholder="name" />
        <button type="submit">Add member</button>
      </form>
      <Added out={create.data} />
      <Added out={add.data} />
      <CallFault error={create.error ?? add.error} />
      <div className="lanes">
        {states.map((state) => (
          <section key={state} aria-label={state}>
            <h2>{state}</h2>
            {list
              .filter((i) => i.state === state)
              .toSorted((a, b) => a.number - b.number)
              .map((i) => (
                <Card key={i.id} issue={i} />
              ))}
          </section>
        ))}
      </div>
    </main>
  );
}

/** One card. Core keeps a member's reference until it changes, so a move draws this card alone
 * (and its new lane). */
const Card = memo(function Card({ issue }: { issue: Issue }) {
  const move = useRun(issueApi["issue.move"]);
  const { teamId, id } = issue;

  const name = `${teamId}-${issue.number}`;
  return (
    <article>
      <Link to="/issues/$team/$id" params={{ team: teamId, id }}>
        {name}
      </Link>{" "}
      {issue.title}
      <select
        aria-label={`State of ${name}`}
        value={issue.state}
        onChange={(event) => {
          const state = states.find((s) => s === event.target.value);
          if (state) move.run({ input: { teamId, id, version: issue.version, state } });
        }}
      >
        {states.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <Moved out={move.data} />
      <CallFault error={move.error} />
    </article>
  );
});

/** `/issues/$team/$id`: one issue's comments, live. Its part is read on its own, so it has its
 * own wait: an empty list before the answer would say "no comments" when that is not known. */
export function Thread({ teamId, issueId }: { teamId: string; issueId: string }) {
  const part = issueBoard.comments.where({ teamId, issueId });
  const thread = useData(part);
  const state = useData(issueBoard.status(part));
  const again = useRun(issueBoard.invalidate);
  const say = useRun(issueApi["comment.add"]);
  if (state?.status !== "ready") {
    return (
      <aside aria-label="Comments">
        <Waiting
          state={state}
          again={() => again.run({ input: { comments: { teamId, issueId } } })}
        />
      </aside>
    );
  }

  return (
    <aside aria-label="Comments">
      {thread.map((c) => (
        <p key={c.id}>{`${c.author}: ${c.text}`}</p>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const text = new FormData(event.currentTarget).get("text");
          if (typeof text === "string") say.run({ input: { teamId, issueId, text } });
          event.currentTarget.reset();
        }}
      >
        <input name="text" aria-label="Comment" />
        <button type="submit">Comment</button>
      </form>
      <Added out={say.data} />
      <CallFault error={say.error} />
    </aside>
  );
}
