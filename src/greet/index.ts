import { capsule } from "@tinkered/core";

import { greetApi } from "./contract";

export { Greeting } from "./greeting";

/** The greet feature's one door: others and the cmds import `@/greet` only. `api`: the one call. */
export const greet = capsule({ label: "greet", exports: { api: greetApi } });
