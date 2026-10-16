import type { Operation, RunResult, Scope } from "@tinker/core";

/** Test dispatch uses the same child-session boundary as server functions. */
export function settleWrite<T, I>(
  root: Scope.Handle,
  op: Operation.Handle<T, I>,
  ...call: Scope.CallArgs<I>
): Promise<RunResult<Awaited<T>>> {
  return Promise.resolve(
    root.controller(op).settle(
      ...([
        {
          ...call[0],
          signal: call[0]?.signal ?? new AbortController().signal,
        },
      ] as Scope.OwnedCall<I>),
    ),
  );
}

/** Return the same value/error contract as a caller's run, after commit. */
export async function write<T, I>(
  root: Scope.Handle,
  op: Operation.Handle<T, I>,
  ...call: Scope.CallArgs<I>
): Promise<Awaited<T>> {
  const result = await settleWrite(root, op, ...call);
  if (result.status === "failed") throw result.error;
  if (result.status === "cancelled") throw result.reason;
  return result.value;
}
