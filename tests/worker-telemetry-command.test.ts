import { expect, test } from "vite-plus/test";

// oxlint-disable-next-line import/no-relative-parent-imports -- Test the actual native command input and startup contract.
import main from "../cmds/worker";

for (const key of ["VICTORIA_TRACES_URL", "VICTORIA_LOGS_URL"] as const) {
  test(`worker requires the matching collector URL when only ${key} is bound`, async () => {
    const codes: number[] = [];

    let reason: unknown;

    const worker = await main({
      env: { [key]: "http://127.0.0.1:19123/collector" },
      args: [],
      cwd: import.meta.dirname,
      signal: new AbortController().signal,
      stdout: { write() {} },
      stderr: { write() {} },
      exit(code, error) {
        codes.push(code);

        reason = error;
      },
    });

    await worker.closed;

    expect(codes).toEqual([78]);

    expect(reason).toMatchObject({
      kind: "MissingTag",
      payload: {
        label: key === "VICTORIA_TRACES_URL" ? "telemetry.logsUrl" : "telemetry.tracesUrl",
      },
    });
  });
}
