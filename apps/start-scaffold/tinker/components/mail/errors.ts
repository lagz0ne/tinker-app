export declare namespace Errors {
  type Payloads = { BadSettings: { part: "mail"; keys: string[] } };
}

/**
 * A bad SMTP setting keeps its key names at the app boundary.
 * @param kind - From the failing reader; why: choose the managed error.
 * @param payload - From the failing reader; why: keep the bad key names.
 */
export function raise<N extends keyof Errors.Payloads>(
  kind: N,
  payload: Errors.Payloads[N],
): never {
  throw Object.assign(new Error(kind), { kind, payload });
}
