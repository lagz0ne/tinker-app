import { expect, test } from "vite-plus/test";

// oxlint-disable-next-line import/no-relative-parent-imports -- Test the native command contract.
import serverMain from "../cmds/server";

for (const [args, expected] of [
  [[], 78],
  [["extra"], 64],
] as const) {
  test(`server input and startup close before exit ${expected}`, async () => {
    const stop = new AbortController();
    const codes: number[] = [];
    let errors = "";

    const app = await serverMain({
      env: {},
      args,
      signal: stop.signal,
      stdout: { write() {} },
      stderr: {
        write(text) {
          errors += text;
        },
      },
      exit(code, reason) {
        codes.push(code);
        stop.abort(reason);
      },
    });

    await app.closed;

    expect(codes).toEqual([expected]);
    expect((await app.fetch(new Request("http://proof.test"))).status).toBe(503);
    if (expected === 78) expect(errors).toBe("");
    else expect(errors).toContain("Usage:");
  });
}
