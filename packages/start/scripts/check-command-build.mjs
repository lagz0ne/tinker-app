import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { serverFile } from "../lib/named.mjs";

const unused = "app_scope_unused_component_export";
const used = "app_scope_used_component_export";

/** Inspect JavaScript only: maps and build logs may retain unused source text. */
function chunks(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return chunks(file);
    return entry.name.endsWith(".js") ? [readFileSync(file, "utf8")] : [];
  });
}

for (const app of process.argv.slice(2)) {
  const source = resolve(app);
  const fixture = mkdtempSync(join(tmpdir(), "start-command-build-"));
  try {
    cpSync(source, fixture, {
      recursive: true,
      filter: (file) => !["node_modules", "dist", ".tinker", ".tanstack"].includes(basename(file)),
    });
    symlinkSync(join(source, "node_modules"), join(fixture, "node_modules"), "dir");
    mkdirSync(join(fixture, "tinker/components/build-proof"), { recursive: true });
    writeFileSync(
      join(fixture, "tinker/components/build-proof/component.json"),
      '{"requires":[]}\n',
    );
    writeFileSync(
      join(fixture, "tinker/components/build-proof/index.server.ts"),
      `export const used = "${used}";\nexport function unused() { return "${unused}"; }\n`,
    );
    writeFileSync(
      join(fixture, "tinker/components/build-proof/styles.ts"),
      'export const style = "z-[137]";\n',
    );
    const entry = join(fixture, serverFile(fixture).file);
    const text = readFileSync(entry, "utf8");
    writeFileSync(
      entry,
      `import { used } from "~/components/build-proof/index.server";\n${text.replace("  close,", `  fetch(request, next) {\n    return new URL(request.url).pathname === "/scope-proof" ? new Response(used) : next(request);\n  },\n  close,`)}`,
    );

    const build = spawnSync("vp", ["build"], { cwd: fixture, encoding: "utf8", timeout: 120000 });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const server = chunks(join(fixture, "dist/server")).join("\n");
    assert.ok(server.includes(used), "the imported component export must be used");
    assert.ok(!server.includes(unused), "the unused component export must be removed");
    if (app.includes("scaffold")) {
      const styles = readdirSync(join(fixture, "dist/client/assets"))
        .filter((file) => file.endsWith(".css"))
        .map((file) => readFileSync(join(fixture, "dist/client/assets", file), "utf8"))
        .join("\n");
      assert.ok(styles.includes("z-index:137"), "Tailwind must read committed component files");
    }
    console.log(
      `${app}: configured command builds; used export stays; unused export is removed${app.includes("scaffold") ? "; component CSS is found" : ""}; EXIT 0`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
