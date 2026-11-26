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

/** A call's answer, as the page gets it. */
type Out<K extends "booking.make" | "booking.cancel"> = Awaited<
  ReturnType<(typeof roomApi)[K]["run"]>
>;

/** What a booking's answer says. Every kind has its case: a new kind fails here. */
function Booked({ out }: { out: Out<"booking.make"> | undefined }) {
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
 * - `refused`, `missing`: the server answered, and the same ask gives the same answer.
 * - `link`: no answer (see `NoAnswer`).
 * - the rest is a bug: it shows the trace id as a ref. The cause is in that trace, never here. */
function Fault({ fault, read }: { fault: RemoteFault; read?: boolean }) {
  const { fault: kind, payload, sent, traceId } = fault;
  if (kind === "link") return <NoAnswer read={read} sent={sent} />;
  if (kind === "missing") return <p role="alert">This page is old. Load it again.</p>;

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

/** `/rooms/$office/mine`: the signed-in person's bookings in the office, on every day, by day and
 * start. Read by `by`, so the server sends this person's rows alone. */
export function MyBookings({ officeId }: { officeId: string }) {
  const me = useData(signedAs);
  const roomPart = roomBoard.rooms.where({ officeId });
  const minePart = roomBoard.bookings.where({ officeId, by: me });
  const list = useData(roomPart);
  const booked = useData(minePart);
  const roomState = useData(roomBoard.status(roomPart));
  const mineState = useData(roomBoard.status(minePart));
  const again = useRun(roomBoard.invalidate);
  const notReady = [roomState, mineState].find((state) => state?.status !== "ready");
  if (roomState?.status !== "ready" || mineState?.status !== "ready") {
    return (
      <main>
        <Waiting
          state={notReady}
          again={() =>
            again.run({ input: { rooms: { officeId }, bookings: { officeId, by: me } } })
          }
        />
      </main>
    );
  }

  const names = new Map(list.map((room) => [room.id, room.name]));
  return (
    <main>
      <h1>My bookings</h1>
      <p>{officeId}</p>
      {booked
        .toSorted((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`))
        .map((b) => (
          <p key={b.id}>{`${b.day} ${b.start}-${b.end} ${names.get(b.roomId) ?? ""}`}</p>
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
          <Slot key={b.id} booking={b} />
        ))}
    </section>
  );
});

/** What a cancel's answer says. */
function Cancelled({ out }: { out: Out<"booking.cancel"> | undefined }) {
  switch (out?.kind) {
    case undefined:
    case "cancelled":
      return null;
    case "notYours":
      return <small role="status">Only the person who booked it can cancel it.</small>;
    case "gone":
      return <small role="status">This booking is gone already.</small>;
  }
}

/** One booking. Its booker gets a button to cancel it; nobody else does. */
const Slot = memo(function Slot({ booking }: { booking: Booking }) {
  const me = useData(signedAs);
  const cancel = useRun(roomApi["booking.cancel"]);
  const { officeId, id, start, end, by } = booking;

  const span = `${start}-${end}`;
  return (
    <div>
      {`${span} ${by}`}
      {by === me && (
        <button
          type="button"
          aria-label={`Cancel ${span}`}
          onClick={() => cancel.run({ input: { officeId, id } })}
        >
          Cancel
        </button>
      )}
      <Cancelled out={cancel.data} />
      <CallFault error={cancel.error} />
    </div>
  );
});
