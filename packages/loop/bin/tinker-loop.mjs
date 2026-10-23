#!/usr/bin/env node
import { runMain } from "@tinker/start/main-host";

import main from "../dist-cli/cli.js";

await runMain(main);
