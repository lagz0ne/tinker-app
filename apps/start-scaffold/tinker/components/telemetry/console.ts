import { tag } from "@tinker/core";

export declare namespace ConsoleOutput {
  type Sink = { writableNeedDrain?: boolean; write(text: string): unknown };
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
