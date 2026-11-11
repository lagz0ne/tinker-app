import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import type { PartState, RemoteFault } from "@tinker/core";
import { useData, useRun } from "@tinker/react";
import { memo } from "react";

import { issueApi, issueBoard, states } from "./contract";
import { me as signedAs, signIn } from "./sign-in";

// The issue board's pages. No state of their own: each reads a keyed part with `useData` and asks
// the server with `useRun`; the server's write comes back as a signal for that part alone.

/** `/issues`: who you are, and which team to open (it is made if nobody has it yet). */
export function IssuesHome() {
  const name = useRun(signIn);
  const navigate = useNavigate();
  const open = useRun(issueApi["team.create"], {
    onSuccess: (_, call) =>
      void navigate({ to: "/issues/$team", params: { team: call.input!.teamId } }),
  });
  const me = useData(signedAs);

  return (
    <main>
      <h1>Issues</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          name.run({
            input: {
              name: (event.currentTarget.elements.namedItem("name") as HTMLInputElement).value,
            },
          });
        }}
      >
        <input name="name" aria-label="Your name" defaultValue={me} />
        <button type="submit">Sign in</button>
      </form>
      {me && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const teamId = (event.currentTarget.elements.namedItem("team") as HTMLInputElement)
              .value;
            open.run({ input: { teamId: teamId.trim().toUpperCase() } });
          }}
        >
          <input name="team" aria-label="Team key" placeholder="ENG" />
          <button type="submit">Open team</button>
        </form>
      )}
    </main>
  );
}

/** A fault, said by its kind, as a page says 403, offline and 500. A bug shows the server's
 * trace id as a ref: the cause is in that trace on the server, never in the tab.
 * `link` is the one kind with no answer from the server. A read is asked again by itself. A call
 * is not: the server may have done it, so the person looks first. */
function Fault({ fault, read }: { fault: unknown; read?: boolean }) {
  const { fault: kind, payload, traceId } = Object(fault) as Partial<RemoteFault>;
  if (!kind) return null;
  if (kind === "link") {
    return (
      <p role="status">
        {read ? "Offline. Trying again." : "No answer. It may be saved. Look, then try again."}
      </p>
    );
  }

  const team = Object(payload).notMember as string | undefined;
  if (kind === "refused") {
    return <p role="alert">{team ? `You are not in team ${team}.` : "Sign in first."}</p>;
  }

  return <p role="alert">{`Something broke.${traceId ? ` Ref ${traceId.slice(0, 8)}` : ""}`}</p>;
}

/** A part that is not ready: not read yet, or a fault that stands. A broken link heals by
 * itself. Any other fault is the server's answer, so it waits for the person: "Try again" asks
 * for the part once more. */
function Waiting({ state, again }: { state: PartState | undefined; again: () => void }) {
  if (state?.status !== "fault") return <p role="status">Loading.</p>;

  return (
    <main>
      <Fault fault={state.fault} read />
      {state.fault.fault !== "link" && (
        <button type="button" onClick={again}>
          Try again
        </button>
      )}
    </main>
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
    return <Waiting state={state} again={() => again.run({ input: { issues: { teamId } } })} />;
  }

  return (
    <main>
      <h1>{teamId}</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.run({
            input: {
              teamId,
              title: (event.currentTarget.elements.namedItem("title") as HTMLInputElement).value,
            },
          });
          event.currentTarget.reset();
        }}
      >
        <input name="title" aria-label="New issue" placeholder="What is wrong?" />
        <button type="submit">Add issue</button>
      </form>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          add.run({
            input: {
              teamId,
              userId: (event.currentTarget.elements.namedItem("user") as HTMLInputElement).value,
            },
          });
          event.currentTarget.reset();
        }}
      >
        <input name="user" aria-label="Add member" placeholder="name" />
        <button type="submit">Add member</button>
      </form>
      <Fault fault={create.error ?? add.error} />
      <div className="lanes">
        {states.map((state) => (
          <section key={state} aria-label={state}>
            <h2>{state}</h2>
            {list
              .filter((i) => i.state === state)
              .toSorted((a, b) => a.number - b.number)
              .map((i) => (
                <Card key={i.id} teamId={teamId} id={i.id} />
              ))}
          </section>
        ))}
      </div>
      <Outlet />
    </main>
  );
}

/** One card: it reads its own member, so a move draws this card alone (and its new lane). */
const Card = memo(function Card({ teamId, id }: { teamId: string; id: string }) {
  const issue = useData(issueBoard.issues.of({ teamId, id }));
  const move = useRun(issueApi["issue.move"]);
  if (!issue) return null;

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
        onChange={(event) =>
          move.run({
            input: { teamId, id, version: issue.version, state: event.target.value as never },
          })
        }
      >
        {states.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      {move.data?.kind === "stale" && <small role="status">Changed by someone else.</small>}
      <Fault fault={move.error} />
    </article>
  );
});

/** `/issues/$team/$id`: one issue's comments, live. */
export function Thread({ teamId, issueId }: { teamId: string; issueId: string }) {
  const thread = useData(issueBoard.comments.where({ teamId, issueId }));
  const say = useRun(issueApi["comment.add"]);

  return (
    <aside aria-label="Comments">
      {thread.map((c) => (
        <p key={c.id}>{`${c.author}: ${c.text}`}</p>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          say.run({
            input: {
              teamId,
              issueId,
              text: (event.currentTarget.elements.namedItem("text") as HTMLInputElement).value,
            },
          });
          event.currentTarget.reset();
        }}
      >
        <input name="text" aria-label="Comment" />
        <button type="submit">Comment</button>
      </form>
      <Fault fault={say.error} />
    </aside>
  );
}
