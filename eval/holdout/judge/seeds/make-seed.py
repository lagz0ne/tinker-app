# One negative seed per rule, as text edits on golden hb4 src/rooms/ops.server.ts. usage: make.py <rule> <file>
import sys
rule, p = sys.argv[1], sys.argv[2]; s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, (rule, a[:60]); s = s.replace(a, b)
if rule == "R1":   # member.add runs no member check
    rep('''  depends: { office: members.controller, ok: inOffice },
  run: ({ office, ok }, { input }) => {
    if (!ok.run({ input })) return { kind: "gone" as const };

    office.set(input);''', '''  depends: { office: members.controller },
  run: ({ office }, { input }) => {
    office.set(input);''')
if rule == "R2":   # the read hook lets every part through
    rep('''  depends: { ok: inOffice, me: caller.required },
  run: ({ ok, me }, { input }) => {
    const part = { officeId: "", ...roomBoard.part(input) };
    if ("by" in part && part.by === me) return undefined;
    const ask = { input: { officeId: part.officeId } };
    return ok.run(ask) ? undefined : input.refuse({ notMember: part.officeId });''', '''  depends: { me: caller.required },
  run: ({ me }, { input }) => {
    const part = { officeId: "", ...roomBoard.part(input) };
    if ("by" in part && part.by === me) return undefined;
    return undefined;''')
if rule == "R3":   # the start hook writes a member row
    rep('''  input: transport.hook.start,
  run: (_, { input }) => {
    const me = input.meta.who;
    return me ? { tags: [caller(me)] } : input.refuse({ signIn: true });''', '''  input: transport.hook.start,
  depends: { office: members.controller },
  run: ({ office }, { input }) => {
    const me = input.meta.who;
    if (me) office.set({ officeId: "lobby", userId: me });
    return me ? { tags: [caller(me)] } : input.refuse({ signIn: true });''')
if rule == "R4":   # a taken booking still writes
    rep('''    if (that.some((b) => b.start < end && start < b.end)) return { kind: "taken" as const };''', '''    if (that.some((b) => b.start < end && start < b.end)) {
      book.set({ officeId, roomId, day, id: random.uuid(), start, end, by: me });
      return { kind: "taken" as const };
    }''')
if rule == "R5":   # the overlap check reads the whole day of the office
    rep('''    const that = book.where({ officeId, roomId, day }).get();''', '''    const that = book.where({ officeId, day }).get();''')
if rule == "R6":   # by from the input
    rep('''    book.set({ officeId, roomId, day, id, start, end, by: me });''', '''    book.set({ officeId, roomId, day, id, start, end, by: input.start });''')
if rule == "R7":   # the room is read before the member check
    rep('''    const room = ok.run({ input }) ? list.of({ officeId, id: roomId }).get() : undefined;
    if (!room) return { kind: "gone" as const };
    const that''', '''    const seen = list.of({ officeId, id: roomId }).get();
    const room = ok.run({ input }) ? seen : undefined;
    if (!room) return { kind: "gone" as const };
    const that''')
if rule == "R8":   # remove deletes the room's bookings of every office
    rep('''    for (const { day, by, id } of book.where({ officeId, roomId }).get()) {
      book.delete({ officeId, roomId, day, by, id });
    }''', '''    for (const b of book.where({ roomId }).get()) {
      book.delete(b);
    }''')
open(p, "w").write(s)
