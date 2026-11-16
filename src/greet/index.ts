import { capsule } from "@tinkered/core";

import { greetApi } from "./contract";

/** The greet feature's capsule. `api`: the one call. Others import a file by its own path (ADR 0160). */
export const greet = capsule({ label: "greet", exports: { api: greetApi } });
