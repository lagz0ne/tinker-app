import { Glob } from "bun";

/**
 * After `vp build`: writes cmds/client-files.gen.ts, one `type: "file"` import per file of
 * dist/client, so `bun build --compile` puts each inside the one binary (Bun's embed pattern).
 * With no client build yet it writes an empty table, so the host still type checks.
 */
const root = new URL("../dist/client/", import.meta.url);
const exists = await Bun.file(new URL("index.html", root)).exists();
const names = exists ? [...new Glob("**/*").scanSync(Bun.fileURLToPath(root))].sort() : [];
const lines = names.map((n, i) => `import f${i} from "../dist/client/${n}" with { type: "file" };`);
const table = names.map((n, i) => `  "/${n}": f${i},`);

await Bun.write(
  new URL("../cmds/client-files.gen.ts", import.meta.url),
  [
    "// Written by scripts/embed-client.ts after `vp build`. Do not edit.",
    "// @ts-nocheck: each import is a file to embed, not a module; the table's type is below.",
    ...lines,
    "",
    "/** Each built client file by its URL path. */",
    `export default {${table.length ? `\n${table.join("\n")}\n` : ""}} as unknown as Record<string, string>;`,
    "",
  ].join("\n"),
);

console.log(`embedded ${names.length} client files`);
