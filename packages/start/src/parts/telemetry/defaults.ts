import { tinker } from "../../../package.json";

/** Direct source users read the same table; tinker() replaces this with the generated file. */
export const telemetryEnv = tinker.parts.telemetry.env;
