import { existsSync } from "node:fs";

import { runMain } from "@tinker/start/main-host";

import main from "../dist-cli/cli.js";

if (existsSync(".env")) process.loadEnvFile();
await runMain(main);
