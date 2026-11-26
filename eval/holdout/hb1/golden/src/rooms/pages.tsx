import { useNavigate } from "@tanstack/react-router";
import { operation, type PartState, type RemoteFault } from "@tinkered/core";
import { useData, useRun } from "@tinkered/react";
import { memo } from "react";
import { z } from "zod";

import { type Booking, type Room, roomApi, roomBoard } from "./contract";
import { me as signedAs, signIn } from "./sign-in";

// The room booking pages. No state of their own: each reads a keyed part with `useData` and asks
// the server with `useRun`; the server's write comes back as a signal for that part alone.

/** Opens an office on a day: the office is made if it is new. The page goes to the key in the
 * answer, never to its own copy. */
const openOffice = operation({
  label: "rooms.open",
  input: z.object({ officeId: z.string(), day: z.string() }),
  depends: { create: roomApi["office.create"] },
  run: async ({ create }, { input }) => {
    const out = await create.run({ input: { officeId: input.officeId } });
    return { office: out.officeId, day: input.day };
  },
});

/** `/rooms`: who you are, and which office and day to open. */
export function RoomsHome() {
  const signedIn = useRun(signIn);
  const navigate = useNavigate();
  const open = useRun(openOffice, {
    onSuccess: (params) => void navigate({ to: "/rooms/$office/$day", params }),
  });
  const me = useData(signedAs);

  return (
    <main>
      <h1>Rooms</h1>
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
            const form = new FormData(event.currentTarget);
            const [officeId, day] = [form.get("office"), form.get("day")];
            if (typeof officeId === "string" && typeof day === "string") {
              open.run({ input: { officeId, day } });
            }
          }}
        >
          <input name="office" aria-label="Office key" placeholder="HQ" />
          <input name="day" type="date" aria-label="Day" />
          <button type="submit">Open office</button>
        </form>
      )}
      <CallFault error={open.error} />
    </main>
  );
}

/** A refusal's payload, when the reader is not in the office. */
const notMember = z.object({ notMember: z.string() });

/** What a booking's answer says. Every kind has its case: a new kind fails here. */
function Booked({
  out,
}: {
  out: Awaited<ReturnType<(typeof roomApi)["booking.make"]["run"]>> | undefined;
}) {
  switch (out?.kind) {
    case undefined:
    case "booked":
      return null;
    case "taken":
      return <p role="status">That room is taken then. Pick another time or room.</p>;
    case "gone":
      return <p role="status">That room is gone, or you are not in this office.</p>;
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

/** A fault, said by who spoke: the server's answer, or this side with no answer.
 * - `refused`: the server answered, and the same ask gives the same answer.
 * - `link`: no answer (see `NoAnswer`).
 * - the rest is a bug or an old page: it shows the trace id as a ref. The cause is in that trace,
 *   never here. */
function Fault({ fault, read }: { fault: RemoteFault; read?: boolean }) {
  const { fault: kind, payload, sent, traceId } = fault;
  if (kind === "link") return <NoAnswer read={read} sent={sent} />;

  const office = notMember.safeParse(payload).data?.notMember;
  if (kind === "refused") {
    return <p role="alert">{office ? `You are not in office ${office}.` : "Sign in first."}</p>;
  }

  return <p role="alert">{`Something broke.${traceId ? ` Ref ${traceId.slice(0, 8)}` : ""}`}</p>;
}

/** A call's error: shown when it is a fault of the booking api. */
function CallFault({ error }: { error: unknown }) {
  return roomApi.fault.is(error) ? <Fault fault={error} /> : null;
}

/** A page whose parts are not all ready: not read yet, or a fault that stands. A broken link heals
 * by itself. Any other fault is the server's answer, so it waits for the person: "Try again" asks
 * for each part of the page once more. */
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

/** `/rooms/$office/$day`: each room of the office with its bookings of that day, live. */
export function DayBoard({ officeId, day }: { officeId: string; day: string }) {
  const roomPart = roomBoard.rooms.where({ officeId });
  const dayPart = roomBoard.bookings.where({ officeId, day });
  const list = useData(roomPart);
  const booked = useData(dayPart);
  const roomState = useData(roomBoard.status(roomPart));
  const dayState = useData(roomBoard.status(dayPart));
  const again = useRun(roomBoard.invalidate);
  const make = useRun(roomApi["booking.make"]);
  const notReady = [roomState, dayState].find((state) => state?.status !== "ready");
  if (roomState?.status !== "ready" || dayState?.status !== "ready") {
    return (
      <main>
        <Waiting
          state={notReady}
          again={() => again.run({ input: { rooms: { officeId }, bookings: { officeId, day } } })}
        />
      </main>
    );
  }

  return (
    <main>
      <h1>{officeId}</h1>
      <p>{day}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const [roomId, start, end] = [form.get("room"), form.get("start"), form.get("end")];
          if (typeof roomId !== "string" || typeof start !== "string") return;
          if (typeof end === "string") make.run({ input: { officeId, roomId, day, start, end } });
        }}
      >
        <select name="room" aria-label="Room">
          {list.map((room) => (
            <option key={room.id} value={room.id}>
              {room.name}
            </option>
          ))}
        </select>
        <input name="start" type="time" aria-label="Start" />
        <input name="end" type="time" aria-label="End" />
        <button type="submit">Book</button>
      </form>
      <Booked out={make.data} />
      <CallFault error={make.error} />
      {list
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((room) => (
          <RoomDay key={room.id} room={room} booked={booked} />
        ))}
    </main>
  );
}

/** One room's bookings of the day, by start. */
const RoomDay = memo(function RoomDay({
  room,
  booked,
}: {
  room: Room;
  booked: readonly Booking[];
}) {
  return (
    <section aria-label={room.name}>
      <h2>{room.name}</h2>
      {booked
        .filter((b) => b.roomId === room.id)
        .toSorted((a, b) => a.start.localeCompare(b.start))
        .map((b) => (
          <p key={b.id}>{`${b.start}-${b.end} ${b.by}`}</p>
        ))}
    </section>
  );
});
