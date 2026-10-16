import { operation } from "@tinker/core";

import { importFile, readImport, importBatch } from "@/backend/import.server";
import { files } from "@/backend/modules";

export const runImport = operation({
  label: "import.run",
  depends: {
    files,
    path: importFile,
    read: readImport.controller,
    batch: importBatch.controller,
  },
  run: async ({ files, path, read, batch }, { signal, log }) => {
    const rows = await read.run({
      rawInput: await files.readFile(path, { encoding: "utf8", signal }),
    });
    let changed = 0;
    for (let offset = 0; offset < rows.length; offset += 100) {
      signal.throwIfAborted();
      const result = await batch.settle({
        rawInput: { rows: rows.slice(offset, offset + 100) },
        signal,
      });
      if (result.status === "failed") throw result.error;

      if (result.status === "cancelled") throw result.reason;
      changed += result.value.changed;
      log("import.batch", {
        rows: Math.min(100, rows.length - offset),
        changed: result.value.changed,
      });
    }
    return { rows: rows.length, changed };
  },
});
