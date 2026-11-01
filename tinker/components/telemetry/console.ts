import { tag } from "@tinker/core";

export declare namespace ConsoleOutput {
  /** `fd` lets a telemetry worker write the same lines straight to the descriptor. */
  type Sink = { writableNeedDrain?: boolean; fd?: number; write(text: string): unknown };
  type Methods = {
    error(value: unknown): void;
    warn(value: unknown): void;
    info(value: unknown): void;
  };
}

/**
 * Where a server root writes its JSON log lines. The command binds the host's stdout stream
 * (ADR 0113); a root with none writes no lines.
 */
export const consoleOutput = tag<ConsoleOutput.Sink | null>({
  label: "telemetry.console",
  default: null,
});

/** Where a tab shows its log records. The browser command binds the tab's `console` (ADR 0113). */
export const logConsole = tag<ConsoleOutput.Methods | null>({
  label: "telemetry.logConsole",
  default: null,
});
