import { type Scope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { expect, test, vi } from "vite-plus/test";

import { migrate } from "~/components/database/index.server";
import { deliverMailBatch, outboxWake } from "~/components/mail/index.server";

// oxlint-disable-next-line import/no-relative-parent-imports -- Exercise the actual command lifecycle.
import main from "../cmds/worker";

const injected = vi.hoisted(() => ({ presets: [] as Scope.Options["presets"] }));

vi.mock("@tinker/core", async (original) => {
  const core = await original<typeof import("@tinker/core")>();
  return {
    ...core,
    createScope: (options: Scope.Options) =>
      core.createScope({ ...options, presets: injected.presets }),
  };
});

test("worker command exits zero after a plain delivery error then SIGTERM", async () => {
  const stop = new AbortController();
  const waiting = Promise.withResolvers<void>();
  const codes: number[] = [];
  let output = "";
  let attempts = 0;
  injected.presets = [
    preset(migrate, async () => {}),
    preset(deliverMailBatch, async () => {
      if (++attempts === 1) throw new Error("temporary database failure");
      return { claimed: 0, sent: 0, failed: 0 };
    }),
    preset(outboxWake, async () => ({
      listen: async () => {},
      retry: async () => {},
      wait: async () => {
        waiting.resolve();
        await new Promise<void>((resolve) =>
          stop.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    })),
  ];

  try {
    const worker = await main({
      env: {
        DATABASE_URL: "postgres://proof",
        SMTP_URL: "smtp://127.0.0.1:11026",
        SMTP_FROM: "proof@example.test",
      },
      args: [],
      signal: stop.signal,
      stdout: {
        write: (text) => {
          output += text;
        },
      },
      stderr: { write() {} },
      exit: (code) => {
        codes.push(code);
      },
    });
    await waiting.promise;

    stop.abort(new Error("SIGTERM"));
    await worker.closed;

    expect(attempts).toBe(2);
    expect(output).toContain("outbox.unavailable");
    expect(codes).toEqual([]);
    expect(output).toContain("outbox worker stopped");
    expect(codes[0] ?? 0).toBe(0);
  } finally {
    injected.presets = [];
    stop.abort();
  }
});
