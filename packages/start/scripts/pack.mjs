import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Pack the tooling package locally. This publishes nothing and pins no copied source bytes. */
const dir = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(dir, "packs"));
mkdirSync(out, { recursive: true });
execFileSync("vp", ["pm", "pack", "--pack-destination", out], { cwd: dir, stdio: "inherit" });
