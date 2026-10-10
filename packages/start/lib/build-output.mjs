import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compressBytes } from "./compression.mjs";

/** This base's folder: the parent of lib/, wherever it is installed or copied. */
const baseRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Escape a path so each character matches only itself in a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** This base's own body chunk, found by its full path, not by folder names. */
const bodyFile = new RegExp(`^${escapeRegExp(join(baseRoot, "src/backend/body.server.ts"))}$`);

/**
 * Client output only: the hint changes the hash and shifts the source map by one line.
 * @param {boolean} hints - From tinker(); why: opt out of Chrome's eager entry compilation.
 */
export function clientOutput(hints = true) {
  return {
    name: "tinker:client-output",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    augmentChunkHash: (chunk) => (hints && chunk.isEntry ? "//# allFunctionsCalledOnLoad" : ""),
    generateBundle(_options, bundle) {
      if (!hints) return;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk" || !chunk.isEntry) continue;
        chunk.code = `//# allFunctionsCalledOnLoad\n${chunk.code}`;
        if (chunk.map) chunk.map.mappings = `;${chunk.map.mappings}`;
        const map = bundle[`${chunk.fileName}.map`];
        if (map) {
          const source = JSON.parse(String(map.source));
          source.mappings = `;${source.mappings}`;
          map.source = JSON.stringify(source);
        }
      }
    },
    async writeBundle(options) {
      for (const entry of await readdir(options.dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || ![".js", ".css", ".html"].includes(extname(entry.name))) continue;
        const file = join(entry.parentPath, entry.name);
        const bytes = await readFile(file);
        await writeFile(`${file}.br`, await compressBytes(bytes, "br", 11));
        await writeFile(`${file}.gz`, await compressBytes(bytes, "gzip"));
      }
    },
  };
}

/** Keep Start's request code out of TanStack's large module context in server builds. */
export function serverOutput() {
  return {
    name: "tinker:server-output",
    apply: "build",
    configEnvironment(name) {
      if (name !== "ssr") return;
      return {
        resolve: { external: ["@tinker/core"] },
        build: {
          rolldownOptions: {
            output: {
              codeSplitting: {
                includeDependenciesRecursively: true,
                groups: [
                  {
                    name: "tinker-start",
                    test: bodyFile,
                  },
                ],
              },
            },
          },
        },
      };
    },
  };
}
