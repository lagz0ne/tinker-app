import { tag } from "@tinker/core";

export declare namespace ConsoleOutput {
  type Sink = { writableNeedDrain: boolean; write(text: string): boolean };
}

/** The server uses stdout unless its host binds a sink; a tab uses its own console. */
export const consoleOutput = tag<ConsoleOutput.Sink | null>({
  label: "telemetry.console",
  default: null,
});
