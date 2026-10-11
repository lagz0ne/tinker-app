import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../..");

// registry-source reads both apps, release URLs, the catalog, and workspace package manifests.
const inputs = [
  "apps/start-scaffold",
  "apps/start-min",
  "packages/*/package.json",
  "packages/start/lib/release.mjs",
  "pnpm-workspace.yaml",
];

/** Read the commit's index, including Git's temporary index for a commit by path. */
async function checkStagedRegistry() {
  const copy = await mkdtemp(join(tmpdir(), "start-registry-staged-"));
  try {
    const files = execFileSync("git", ["ls-files", "-z", "--", ...inputs], { cwd: root });
    execFileSync("git", ["checkout-index", "-z", "--stdin", `--prefix=${copy}/`], {
      cwd: root,
      input: files,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const { checkRegistryIndex } = await import(
      pathToFileURL(join(copy, "apps/start-scaffold/maintain/check-registry-index.mjs"))
    );
    const { files: count } = await checkRegistryIndex();
    console.log(`PASS: registry index matches source; ${count} emitted files.`);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

try {
  await checkStagedRegistry();
} catch (error) {
  console.error(
    "Registry index check failed. Fix: pnpm --dir apps/start-scaffold run registry:build",
  );
  console.error(error.message.split("\n")[0]);
  process.exitCode = 1;
}
