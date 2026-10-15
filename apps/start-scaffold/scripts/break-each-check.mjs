import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { breakChecks } from "../../../tools/testing/break-checks.mjs";

/** The lander runs mutations. --list only checks the recipe paths and text. */
const owner = resolve(import.meta.dirname, "..");
const changes = JSON.parse(readFileSync(resolve(import.meta.dirname, "break-cases.json"), "utf8"));
breakChecks(owner, changes);
