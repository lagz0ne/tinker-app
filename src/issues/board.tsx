import { useNavigate } from "@tanstack/react-router";
import type { PartState, RemoteFault } from "@tinkered/core";
import { useData, useRun } from "@tinkered/react";
import { memo } from "react";
import { z } from "zod";

import { type Issue, issueApi, issueBoard, roles, states } from "./contract";
import { showLabel, shownLabel } from "./filter";
import { me as signedAs, signIn } from "./sign-in";

// The issue board's pages. No state of their own: each reads a keyed part with `useData` and asks
// the server with `useRun`; the server's write comes back as a signal for that part alone.

/** `/issues`: who you are, and which team to open (it is made if nobody has it yet). */
export function IssuesHome() {
  const signedIn = useRun(signIn);
  const navigate = useNavigate();
  const open = useRun(issueApi["team.create"], {
    onSuccess: (out) => void navigate({ to: "/issues/$team", params: { team: out.teamId } }),
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
            if (typeof teamId === "string") open.run({ input: { teamId } });
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

/** Every change the board asks for. */
type Change =
  | "team.add"
  | "team.archive"
  | "issue.create"
  | "issue.move"
  | "issue.rename"
  | "issue.label"
  | "issue.assign";

/** A change's answer, as the page gets it. */
type Out = Awaited<ReturnType<(typeof issueApi)[Change]["run"]>>;

/** What each answer says; a success says nothing. Each kind has its line: a new kind fails here. */
const says: Record<Out["kind"], string | null> = {
  created: null,
  added: null,
  moved: null,
  renamed: null,
  labeled: null,
  assigned: null,
  stale: "Changed by someone else.",
  gone: "That is gone, or you are not in this team.",
  archived: "This team is archived.",
  forbidden: "You can only view this team.",
  notAssignable: "Only a member of the team can take it.",
};

/** What a call's answer says, as a status. */
function Said({ out }: { out: Out }) {
  const text = says[out.kind];
  return text && <small role="status">{text}</small>;
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

/** `/issues/mine`: the issues assigned to the signed-in person, in each team they are in. */
export function MyIssues() {
  const me = useData(signedAs);
  const part = issueBoard.members.where({ userId: me });
  const places = useData(part);
  const state = useData(issueBoard.status(part));
  const again = useRun(issueBoard.invalidate);
  if (state?.status !== "ready") {
    return (
      <main>
        <Waiting state={state} again={() => again.run({ input: { members: { userId: me } } })} />
      </main>
    );
  }

  return (
    <main>
      <h1>My issues</h1>
      {places
        .map((p) => p.teamId)
        .toSorted()
        .map((teamId) => (
          <Mine key={teamId} teamId={teamId} me={me} />
        ))}
    </main>
  );
}

/** One team's issues that are assigned to `me`, by number. */
function Mine({ teamId, me }: { teamId: string; me: string }) {
  const list = useData(issueBoard.issues.where({ teamId }));

  return (
    <section aria-label={teamId}>
      <h2>{teamId}</h2>
      {list
        .filter((i) => i.assignee === me)
        .toSorted((a, b) => a.number - b.number)
        .map((i) => (
          <article key={i.id} aria-label={`${teamId}-${i.number}`}>
            <strong>{`${teamId}-${i.number}`}</strong> {i.title} <small>{i.state}</small>
          </article>
        ))}
    </section>
  );
}

/** `/issues/$team`: the team's issues in four lanes, live. With a label shown, only the issues
 * that carry it. */
export function Board({ teamId }: { teamId: string }) {
  const part = issueBoard.issues.where({ teamId });
  const list = useData(part);
  const state = useData(issueBoard.status(part));
  const again = useRun(issueBoard.invalidate);
  const create = useRun(issueApi["issue.create"]);
  const add = useRun(issueApi["team.add"]);
  const archive = useRun(issueApi["team.archive"]);
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
          const form = new FormData(event.currentTarget);
          const userId = form.get("user");
          const role = roles.find((r) => r === form.get("role"));

          if (typeof userId === "string" && role) add.run({ input: { teamId, userId, role } });
          event.currentTarget.reset();
        }}
      >
        <input name="user" aria-label="Add member" placeholder="name" />
        <select name="role" aria-label="Role">
          {roles.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <button type="submit">Add member</button>
      </form>
      <button type="button" onClick={() => archive.run({ input: { teamId } })}>
        Archive team
      </button>
      {create.data && <Said out={create.data} />}
      {add.data && <Said out={add.data} />}
      {archive.data && <Said out={archive.data} />}
      <CallFault error={create.error ?? add.error ?? archive.error} />
      <Lanes list={list} teamId={teamId} />
    </main>
  );
}

/** The four lanes, under the label filter: with a label shown, only the issues that carry it. A
 * card takes its labels as one string (`"bug ui"`), so a change of another card's labels does
 * not draw it again. */
function Lanes({ list, teamId }: { list: readonly Issue[]; teamId: string }) {
  const tags = useData(issueBoard.labels.where({ teamId }));
  // Who may take an issue: the team's members, not its viewers.
  const people = useData(issueBoard.members.where({ teamId }))
    .filter((m) => m.role === "member")
    .map((m) => m.userId)
    .toSorted()
    .join(" ");
  const known = [...new Set(tags.map((t) => t.name))].toSorted();
  // A label that no issue of this team has shows all.
  const shown = useData(shownLabel);
  const label = known.includes(shown) ? shown : "";
  const show = useRun(showLabel);

  return (
    <>
      <select
        aria-label="Show label"
        value={label || "all"}
        onChange={(event) => {
          const name = event.target.value;
          show.run({ input: { name: name === "all" ? "" : name } });
        }}
      >
        {["all", ...known].map((n) => (
          <option key={n}>{n}</option>
        ))}
      </select>
      <div className="lanes">
        {states.map((state) => (
          <section key={state} aria-label={state}>
            <h2>{state}</h2>
            {list
              .filter((i) => i.state === state)
              .filter((i) => !label || tags.some((t) => t.id === i.id && t.name === label))
              .map((i) => (
                <Card
                  key={i.id}
                  issue={i}
                  people={people}
                  labels={tags
                    .filter((t) => t.id === i.id)
                    .map((t) => t.name)
                    .toSorted()
                    .join(" ")}
                />
              ))}
          </section>
        ))}
      </div>
    </>
  );
}

/** One card. Core keeps a member's reference until it changes, so a move draws this card alone
 * (and its new lane). */
const Card = memo(function Card({
  issue,
  labels,
  people,
}: {
  issue: Issue;
  labels: string;
  people: string;
}) {
  const move = useRun(issueApi["issue.move"]);
  const rename = useRun(issueApi["issue.rename"]);
  const { teamId, id, version } = issue;

  const name = `${teamId}-${issue.number}`;
  return (
    <article aria-label={name}>
      <strong>{name}</strong> {issue.title}
      <select
        aria-label={`State of ${name}`}
        value={issue.state}
        onChange={(event) => {
          const state = states.find((s) => s === event.target.value);
          if (state) move.run({ input: { teamId, id, version, state } });
        }}
      >
        {states.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const title = new FormData(event.currentTarget).get("title");
          if (typeof title === "string") rename.run({ input: { teamId, id, version, title } });
        }}
      >
        <input
          name="title"
          aria-label={`Title of ${name}`}
          defaultValue={issue.title}
          key={version}
        />
        <button type="submit">Rename</button>
      </form>
      <Assignee issue={issue} name={name} people={people} />
      <Labels issue={issue} name={name} labels={labels} />
      {move.data && <Said out={move.data} />}
      {rename.data && <Said out={rename.data} />}
      <CallFault error={move.error ?? rename.error} />
    </article>
  );
});

/** A card's assignee: `nobody`, or one of the team's members. */
function Assignee({ issue, name, people }: { issue: Issue; name: string; people: string }) {
  const assign = useRun(issueApi["issue.assign"]);
  const { teamId, id, version } = issue;

  return (
    <>
      <select
        aria-label={`Assignee of ${name}`}
        value={issue.assignee ?? "nobody"}
        onChange={(event) => {
          const to = event.target.value;
          assign.run({ input: { teamId, id, version, userId: to === "nobody" ? null : to } });
        }}
      >
        {["nobody", ...people.split(" ")].map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      {assign.data && <Said out={assign.data} />}
      <CallFault error={assign.error} />
    </>
  );
}

/** A card's labels: each one a button that takes it off, and a form that puts one on. */
function Labels({ issue, name, labels }: { issue: Issue; name: string; labels: string }) {
  const label = useRun(issueApi["issue.label"]);
  const { teamId, id, version } = issue;

  return (
    <>
      {labels &&
        labels.split(" ").map((n) => (
          <button
            type="button"
            key={n}
            aria-label={`Remove ${n} from ${name}`}
            onClick={() => label.run({ input: { teamId, id, version, name: n, on: false } })}
          >
            {n}
          </button>
        ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const n = new FormData(event.currentTarget).get("label");
          if (typeof n === "string") {
            label.run({ input: { teamId, id, version, name: n, on: true } });
          }
          event.currentTarget.reset();
        }}
      >
        <input name="label" aria-label={`Label for ${name}`} />
        <button type="submit">Add label</button>
      </form>
      {label.data && <Said out={label.data} />}
      <CallFault error={label.error} />
    </>
  );
}
