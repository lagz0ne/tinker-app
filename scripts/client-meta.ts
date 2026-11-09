import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Plugin } from "vite-plus";

/**
 * A Vite plugin: after the client build, writes `dist/client-meta.json` in the shape of a Bun
 * metafile (`inputs`, each with its `imports`), so `check:client` and `check:tests` read the
 * bundler's own module list. Paths are from the repo root, as Bun writes them.
 */
export function clientMeta(root: string): Plugin {
  const base = root.replace(/\/$/, "");
  const local = (id: string) => (id.startsWith(`${base}/`) ? id.slice(base.length + 1) : id);

  return {
    name: "tinker:client-meta",
    apply: "build",
    generateBundle(_, bundle) {
      const ids = Object.values(bundle).flatMap((out) =>
        out.type === "chunk" ? out.moduleIds : [],
      );
      const inputs = Object.fromEntries(
        ids.map((id) => {
          const info = this.getModuleInfo(id);
          const imports = [...(info?.importedIds ?? []), ...(info?.dynamicallyImportedIds ?? [])];
          return [local(id), { imports: imports.map((path) => ({ path: local(path) })) }];
        }),
      );
      // Beside dist/client, not in it: the binary embeds dist/client, and this list is no page file.
      mkdirSync(join(base, "dist"), { recursive: true });
      writeFileSync(join(base, "dist/client-meta.json"), JSON.stringify({ inputs }, null, 2));
    },
  };
}
