// Card 6b, phase 1: the contract for `tinker/components.lock`, written before the code.
//
// A lock records what each component was copied from, so `check` can tell a user edit
// (local != lock) from a Start bump (lock != registry).
//
// State table for update + lock (component `u`, registry moves v1 -> v2, lock holds v1):
//
// | state before update        | folder | .new | .old | lock | after update                        |
// |----------------------------|--------|------|------|------|-------------------------------------|
// | clean                      | v1     | -    | -    | v1   | folder v2, lock v2, no temp files   |
// | clean, registry moved on   | v1     | -    | -    | v1   | no refusal; folder v2, lock v2      |
// | local edit (disk != lock)  | edited | -    | -    | v1   | refuse; --force -> v2 and lock v2   |
// | no lock entry              | v1     | -    | -    | -    | card 6 refusal against the registry |
// | killed after the swap      | v2     | -    | v1   | v1   | roll forward: lock v2, .old dropped |
// | killed before the swap     | -      | v2   | v1   | v1   | restore v1, then v2, lock v2        |
// | lock write fails           | v1     | -    | v1   | v1   | rollback: folder v1, lock unchanged |
// | outside write fails        | v1     | -    | v1   | v1   | rollback: folder v1, lock unchanged |
// | swap rename fails          | v1     | -    | -    | v1   | folder v1, lock unchanged           |

import { existsSync } from "node:fs";
import {
  rename as renameAsync,
  rm as rmAsync,
  writeFile as writeFileAsync,
} from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { updateComponent } from "../lib/component-commands.mjs";
import { entryOf, readLock, writeLock } from "../lib/lock.mjs";
import { basePackage, listFiles } from "../lib/paths.mjs";
import {
  app,
  canonical,
  hashesOf,
  items,
  lockText,
  makeRegistry,
  mV2,
  read,
  setItem,
  shaFile,
  sha,
  snapshot,
  sqlFiles,
  tinker,
  uV1,
  uV2,
  writeFiles,
} from "./registry-fixture.mjs";

/** The lock file's app-relative path. */
const lockPath = "tinker/components.lock";

/** @param {string} root - From a test; why: the app to read. */
function lockOf(root) {
  return JSON.parse(read(root, lockPath));
}

/** Every leftover temp file, so L3 can say "none". @param {string} root - From a test; why: the app. */
function tempFiles(root) {
  return listFiles(root, root).filter(
    (file) => file.includes(".tinker-new") || file.startsWith(".tinker/update"),
  );
}

/** The lock entry a fixture file map would give, for a hand-written lock. */
function entryFor(files, name) {
  return { files: hashesOf(files, `tinker/components/${name}`), start: basePackage.version };
}

/** @param {string} a - From a sort; why: keep the order stable. @param {string} b - From a sort. */
function byText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** @param {string} root - From a test; why: the app. @param {string} name - From a test; why: the component. */
function folderSnapshot(root, name) {
  return snapshot(join(root, "tinker/components", name));
}

/**
 * Run check and prove it wrote nothing.
 * @param {string} root - From a test; why: the app to read.
 * @param {string} registry - From a test; why: the registry to compare with.
 * @param {number} code - From a test; why: the exit code this state should give.
 */
function expectReadOnly(root, registry, code) {
  const before = snapshot(root);
  const run = tinker(root, "check", "--registry", registry);
  expect({ code: run.code, same: snapshot(root) }).toEqual({ code, same: before });
  return run;
}

test("L1a add writes one lock entry per new member, hashing what it wrote", () => {
  const registry = makeRegistry();
  const root = app();

  const run = tinker(root, "add", "a", "--registry", registry);
  expect(run.code).toBe(0);

  const lock = lockOf(root);
  expect(lock.version).toBe(1);
  expect(Object.keys(lock.components)).toEqual(["a", "b", "c"]);
  expect(read(root, lockPath)).toBe(`${canonical(lock)}\n`);

  for (const name of ["a", "b", "c"]) {
    const entry = lock.components[name];
    const paths = Object.keys(entry.files).sort(byText);
    const written = Object.keys(hashesOf(items[name].files, `tinker/components/${name}`)).sort(
      byText,
    );
    expect(paths).toEqual(written);
    expect(entry.start).toBe(basePackage.version);

    for (const path of paths) expect(entry.files[path]).toBe(shaFile(root, path));
  }
});

test("L1b update rewrites this entry and leaves the others alone", () => {
  const registry = makeRegistry();
  const root = app();
  expect(tinker(root, "add", "c", "--registry", registry).code).toBe(0);
  expect(tinker(root, "add", "u", "--registry", registry).code).toBe(0);
  const before = lockOf(root);

  setItem(registry, "u", { files: uV2 });
  const run = tinker(root, "update", "u", "--registry", registry);

  expect(run.code).toBe(0);
  const lock = lockOf(root);
  expect(lock.components.c).toEqual(before.components.c);
  expect(Object.keys(lock.components.u.files).sort(byText)).toEqual([
    "tinker/components/u/component.json",
    "tinker/components/u/fresh.ts",
    "tinker/components/u/index.ts",
  ]);
  for (const [path, hash] of Object.entries(lock.components.u.files)) {
    expect(hash).toBe(shaFile(root, path));
  }
  expect(read(root, lockPath)).toBe(`${canonical(lock)}\n`);
});

test("L2a a failed lock write rolls the folder back and keeps the lock", async () => {
  const registry = makeRegistry();
  const root = app();
  expect(tinker(root, "add", "u", "--registry", registry).code).toBe(0);
  const lockBefore = read(root, lockPath);
  const folderBefore = folderSnapshot(root, "u");
  setItem(registry, "u", { files: uV2 });

  const fs = {
    async writeFile(file, data, options) {
      if (String(file).includes("components.lock.tinker-new")) {
        throw new Error("EIO: simulated lock write");
      }
      return writeFileAsync(file, data, options);
    },
  };

  await expect(updateComponent(root, "u", registry, { fs })).rejects.toThrow(
    "simulated lock write",
  );

  expect(folderSnapshot(root, "u")).toEqual(folderBefore);
  expect(read(root, lockPath)).toBe(lockBefore);
});

test("L2b a failed outside write rolls the folder back and keeps the lock", async () => {
  const registry = makeRegistry();
  const root = app();
  expect(tinker(root, "add", "m", "--registry", registry).code).toBe(0);
  const lockBefore = read(root, lockPath);
  const folderBefore = folderSnapshot(root, "m");
  setItem(registry, "m", { files: mV2 });

  const fs = {
    async writeFile(file, data, options) {
      if (String(file).endsWith("migration.sql.tinker-new")) {
        throw new Error("EIO: simulated outside write");
      }
      return writeFileAsync(file, data, options);
    },
  };

  await expect(updateComponent(root, "m", registry, { fs })).rejects.toThrow(
    "simulated outside write",
  );

  expect(folderSnapshot(root, "m")).toEqual(folderBefore);
  expect(read(root, "drizzle/1_m/migration.sql")).toBe("-- 1_m\n");
  expect(read(root, lockPath)).toBe(lockBefore);
});

test("L2c a failed swap leaves the lock alone", async () => {
  const registry = makeRegistry();
  const root = app();
  expect(tinker(root, "add", "u", "--registry", registry).code).toBe(0);
  const lockBefore = read(root, lockPath);
  const folder = join(root, "tinker/components/u");
  setItem(registry, "u", { files: uV2 });

  const fs = {
    async rename(from, to) {
      if (String(from).endsWith(".new") && String(to) === folder) {
        throw new Error("EXDEV: simulated swap");
      }
      return renameAsync(from, to);
    },
  };

  await expect(updateComponent(root, "u", registry, { fs })).rejects.toThrow("simulated swap");

  expect(read(root, lockPath)).toBe(lockBefore);
});

test("L3 no temp lock and no temp folder after success or failure", async () => {
  const registry = makeRegistry();
  const root = app();
  expect(tinker(root, "add", "u", "--registry", registry).code).toBe(0);
  setItem(registry, "u", { files: uV2 });
  expect(tinker(root, "update", "u", "--registry", registry).code).toBe(0);
  expect(tempFiles(root)).toEqual([]);
  expect(existsSync(join(root, ".tinker/update"))).toBe(false);
  expect(existsSync(join(root, "tinker/components.lock.tinker-new"))).toBe(false);

  const locked = app();
  expect(tinker(locked, "add", "u", "--registry", registry).code).toBe(0);
  const fs = {
    async writeFile(file, data, options) {
      if (String(file).includes("components.lock.tinker-new")) {
        throw new Error("EIO: simulated lock write");
      }
      return writeFileAsync(file, data, options);
    },
  };
  await expect(updateComponent(locked, "u", registry, { fs })).rejects.toThrow("simulated lock");
  expect(tempFiles(locked)).toEqual([]);

  const outside = app();
  expect(tinker(outside, "add", "m", "--registry", registry).code).toBe(0);
  setItem(registry, "m", { files: mV2 });
  const outsideFs = {
    async writeFile(file, data, options) {
      if (String(file).endsWith("migration.sql.tinker-new")) throw new Error("EIO: outside");
      return writeFileAsync(file, data, options);
    },
  };
  await expect(updateComponent(outside, "m", registry, { fs: outsideFs })).rejects.toThrow(
    "EIO: outside",
  );
  expect(tempFiles(outside)).toEqual([]);
});

test("K-roll a killed-after-swap update finishes the lock from disk, and check writes nothing", () => {
  const registry = makeRegistry({ u: { files: uV2 } });
  const root = app({
    ...uV2,
    ".tinker/update/u.old/component.json": '{ "requires": [] }\n',
    ".tinker/update/u.old/index.ts": "export const uVersion = 1;\n",
    ".tinker/update/u.old/stale.ts": "export const stale = true;\n",
    [lockPath]: lockText({
      u: { files: hashesOf(uV1, "tinker/components/u"), start: basePackage.version },
    }),
  });
  const before = snapshot(root);

  const checked = tinker(root, "check", "--registry", registry);
  expect(checked.code).toBe(1);
  expect(checked.lines).toContain("interrupted update: u; run tinker update u");
  expect(snapshot(root)).toEqual(before);

  const run = tinker(root, "update", "u", "--registry", registry);
  expect(run.code).toBe(0);
  expect(run.lines[0]).toBe("finished tinker/components/u from an interrupted update");
  expect(existsSync(join(root, ".tinker/update"))).toBe(false);

  const lock = lockOf(root);
  expect(lock.components.u.files["tinker/components/u/index.ts"]).toBe(
    shaFile(root, "tinker/components/u/index.ts"),
  );
  expect(lock.components.u.files["tinker/components/u/fresh.ts"]).toBe(
    shaFile(root, "tinker/components/u/fresh.ts"),
  );
});

test("E-lock an edit against the lock is refused, and --force replaces it", () => {
  const registry = makeRegistry();
  const root = app();
  expect(tinker(root, "add", "u", "--registry", registry).code).toBe(0);
  writeFiles(root, { "~/tinker/components/u/index.ts": "export const uVersion = 'edited';\n" });
  const edited = snapshot(root);

  const refused = tinker(root, "update", "u", "--registry", registry);
  expect(refused.code).toBe(1);
  expect(refused.lines).toEqual([
    "changed: tinker/components/u/index.ts",
    "tinker update: u has local edits; rerun with --force to replace them",
  ]);
  expect(snapshot(root)).toEqual(edited);

  const forced = tinker(root, "update", "u", "--force", "--registry", registry);
  expect(forced.code).toBe(0);
  expect(read(root, "tinker/components/u/index.ts")).toBe("export const uVersion = 1;\n");
  expect(lockOf(root).components.u.files["tinker/components/u/index.ts"]).toBe(
    shaFile(root, "tinker/components/u/index.ts"),
  );
});

test("E-bump a registry bump is outdated, not an edit", () => {
  const registry = makeRegistry();
  const root = app();
  expect(tinker(root, "add", "u", "--registry", registry).code).toBe(0);
  setItem(registry, "u", { files: uV2 });

  const checked = tinker(root, "check", "--registry", registry);
  expect(checked.code).toBe(0);
  expect(checked.lines).toEqual([
    `outdated: u (lock start ${basePackage.version}; run tinker update u)`,
    `tinker check: 1 components match registry ${registry}`,
  ]);

  const run = tinker(root, "update", "u", "--registry", registry);
  expect(run.code).toBe(0);

  const after = tinker(root, "check", "--registry", registry);
  expect(after.code).toBe(0);
  expect(after.lines.some((line) => line.startsWith("outdated:"))).toBe(false);
  expect(lockOf(root).components.u.files["tinker/components/u/fresh.ts"]).toBe(
    shaFile(root, "tinker/components/u/fresh.ts"),
  );
});

test("E-rule-b a file already equal to the new copy is not an edit", () => {
  const registry = makeRegistry();
  const root = app();
  expect(tinker(root, "add", "u", "--registry", registry).code).toBe(0);
  writeFiles(root, { "~/tinker/components/u/index.ts": "export const uVersion = 2;\n" });
  setItem(registry, "u", { files: uV2 });

  const run = tinker(root, "update", "u", "--registry", registry);

  expect(run.code).toBe(0);
  expect(read(root, "tinker/components/u/index.ts")).toBe("export const uVersion = 2;\n");
  expect(lockOf(root).components.u.files["tinker/components/u/index.ts"]).toBe(
    shaFile(root, "tinker/components/u/index.ts"),
  );
});

test("C-nolock a folder without an entry still checks, with a note", () => {
  const registry = makeRegistry();
  const root = app(items.c.files);

  const run = tinker(root, "check", "--registry", registry);

  expect(run.code).toBe(0);
  expect(run.lines).toEqual([
    "no lock entry: c; run tinker update c to record it",
    `tinker check: 1 components match registry ${registry}`,
  ]);
});

test("C-gone a lock entry with no folder is a finding", () => {
  const registry = makeRegistry();
  const root = app({
    [lockPath]: lockText({
      zzz: { files: {}, start: basePackage.version },
    }),
  });

  const run = tinker(root, "check", "--registry", registry);

  expect(run.code).toBe(1);
  expect(run.lines).toEqual([
    "missing component: zzz is in tinker/components.lock",
    "tinker check: 1 findings",
  ]);
});

test("C-ro check writes nothing: clean, edited, outdated or interrupted", () => {
  const registry = makeRegistry();
  const clean = app();
  expect(tinker(clean, "add", "u", "--registry", registry).code).toBe(0);
  expectReadOnly(clean, registry, 0);

  const edited = app();
  expect(tinker(edited, "add", "u", "--registry", registry).code).toBe(0);
  writeFiles(edited, { "~/tinker/components/u/index.ts": "export const uVersion = 'edited';\n" });
  expectReadOnly(edited, registry, 1);

  const bumped = app();
  expect(tinker(bumped, "add", "u", "--registry", registry).code).toBe(0);
  setItem(registry, "u", { files: uV2 });
  expectReadOnly(bumped, registry, 0);

  const interrupted = app({
    ...uV2,
    ".tinker/update/u.old/index.ts": "export const uVersion = 1;\n",
    [lockPath]: lockText({
      u: { files: hashesOf(uV2, "tinker/components/u"), start: basePackage.version },
    }),
  });
  const run = expectReadOnly(interrupted, registry, 1);
  expect(run.lines).toContain("interrupted update: u; run tinker update u");
});

test("C-badlock a broken lock stops check, add and update without writing", () => {
  const registry = makeRegistry();
  const root = app({
    ...items.c.files,
    ".tinker/update/c.old/index.ts": 'export const cValue = "c";\n',
    [lockPath]: "{ nope\n",
  });
  const before = snapshot(root);

  for (const args of [["check"], ["add", "c"], ["update", "c"]]) {
    const run = tinker(root, ...args, "--registry", registry);
    expect(run.code, args.join(" ")).toBe(1);
    expect(run.lines[0].startsWith(`tinker ${args[0]}: tinker/components.lock: `)).toBe(true);
  }

  expect(snapshot(root)).toEqual(before);
});

test("T1 the entry builder and lock writer write a lock that matches the files", async () => {
  const root = app({ ...items.c.files, "~/drizzle/1_m/migration.sql": "-- 1_m\n" });
  const paths = [
    "tinker/components/c/component.json",
    "tinker/components/c/index.ts",
    "drizzle/1_m/migration.sql",
  ];

  const entry = await entryOf(root, paths, "0.13.0");
  expect(entry.start).toBe("0.13.0");
  expect(Object.keys(entry.files)).toEqual(paths.slice().sort(byText));
  for (const path of paths) expect(entry.files[path]).toBe(shaFile(root, path));

  await writeLock(root, { components: { c: entry }, version: 1 });
  expect(read(root, lockPath)).toBe(`${canonical({ components: { c: entry }, version: 1 })}\n`);
  expect(await readLock(root)).toEqual({ components: { c: entry }, version: 1 });
  expect(await readLock(app())).toEqual({ components: {}, version: 1 });
});

test("K-roll-add add finishes a killed update for a closure member", () => {
  const registry = makeRegistry();
  const root = app({
    ...items.b.files,
    ".tinker/update/b.old/index.ts": 'export const bValue = "b";\n',
  });

  const run = tinker(root, "add", "a", "--registry", registry);

  expect(run.code).toBe(0);
  expect(run.lines[0]).toBe("finished tinker/components/b from an interrupted update");
  expect(run.lines.at(-1)).toBe("tinker add: added c, a");
  expect(existsSync(join(root, ".tinker/update"))).toBe(false);
  expect(Object.keys(lockOf(root).components)).toEqual(["a", "b", "c"]);
  for (const name of ["a", "b", "c"]) {
    const path = `tinker/components/${name}/index.ts`;
    expect(lockOf(root).components[name].files[path]).toBe(shaFile(root, path));
  }
});

test("B1a check measures a component with a sqlite/migrations/ file by its lock and the registry", () => {
  const registry = makeRegistry();
  const entry = entryFor(sqlFiles, "s-sql");
  const sqlEntry = {
    ...entry,
    files: { ...entry.files, ...hashesOf(sqlFiles, "sqlite/migrations") },
  };
  const locked = app({
    ...sqlFiles,
    [lockPath]: lockText({ "s-sql": sqlEntry }),
  });

  const run = tinker(locked, "check", "--registry", registry);

  expect(run.code).toBe(0);
  expect(run.lines).toEqual([`tinker check: 1 components match registry ${registry}`]);

  const edited = app({
    ...sqlFiles,
    "~/tinker/components/s-sql/index.ts": "export const sSqlValue = 'mine';\n",
    [lockPath]: lockText({ "s-sql": sqlEntry }),
  });
  const changed = tinker(edited, "check", "--registry", registry);
  expect(changed.code).toBe(1);
  expect(changed.lines).toEqual([
    "edited: tinker/components/s-sql/index.ts (changed)",
    "tinker check: 1 findings",
  ]);

  const unlocked = app(sqlFiles);
  const noted = tinker(unlocked, "check", "--registry", registry);
  expect(noted.code).toBe(0);
  expect(noted.lines).toEqual([
    "no lock entry: s-sql; run tinker update s-sql to record it",
    `tinker check: 1 components match registry ${registry}`,
  ]);
});

test("B1c update refuses an outside file the old lock does not list when its bytes differ", () => {
  const registry = makeRegistry();
  const outside = "sqlite/migrations/1_sql.sql";
  const root = app({
    ...sqlFiles,
    [`~/${outside}`]: "-- my edit\n",
    [lockPath]: lockText({ "s-sql": entryFor(sqlFiles, "s-sql") }),
  });
  const before = snapshot(root);

  const run = tinker(root, "update", "s-sql", "--registry", registry);

  expect(run.code).toBe(1);
  expect(run.lines).toEqual([
    `conflict: ${outside}`,
    "tinker update: s-sql has local edits; rerun with --force to replace them",
  ]);
  expect(snapshot(root)).toEqual(before);

  const same = app({
    ...sqlFiles,
    [lockPath]: lockText({ "s-sql": entryFor(sqlFiles, "s-sql") }),
  });
  expect(tinker(same, "update", "s-sql", "--registry", registry).code).toBe(0);

  const forced = tinker(root, "update", "s-sql", "--force", "--registry", registry);
  expect(forced.code).toBe(0);
  expect(read(root, outside)).toBe("-- sql\n");
  expect(lockOf(root).components["s-sql"].files[outside]).toBe(shaFile(root, outside));
});

test("B1b check turns a bad registry item into one finding instead of stopping", () => {
  const registry = makeRegistry();
  const root = app({ ...items.c.files, ...items["bad-item"].files });

  const run = tinker(root, "check", "--registry", registry);

  expect(run.code).toBe(1);
  expect(run.lines).toEqual([
    "bad item: bad-item: bad target ~/src/z.ts in bad-item",
    "no lock entry: c; run tinker update c to record it",
    "tinker check: 1 findings",
  ]);
});

test("B2 a stale .old never talks undoSwap into replacing the current folder", async () => {
  const registry = makeRegistry();
  const root = app();
  expect(tinker(root, "add", "u", "--registry", registry).code).toBe(0);
  const folderBefore = folderSnapshot(root, "u");
  const lockBefore = read(root, lockPath);
  writeFiles(root, { ".tinker/update/u.old/index.ts": "export const uVersion = 0;\n" });
  setItem(registry, "u", { files: uV2 });

  const fs = {
    async rm(path, options) {
      if (String(path).endsWith("u.old")) throw new Error("EPERM: simulated stale cleanup");
      return rmAsync(path, options);
    },
  };

  await expect(updateComponent(root, "u", registry, { fs })).rejects.toBeInstanceOf(Error);

  expect(folderSnapshot(root, "u")).toEqual(folderBefore);
  expect(read(root, lockPath)).toBe(lockBefore);
});

test("B3 a kill during an undo leaves the old folder whole for the next run", async () => {
  const registry = makeRegistry();
  const root = app();
  expect(tinker(root, "add", "u", "--registry", registry).code).toBe(0);
  const lockBefore = read(root, lockPath);
  setItem(registry, "u", { files: uV2 });
  const folder = join(root, "tinker/components/u");
  const fs = {
    async writeFile(file, data, options) {
      if (String(file).includes("components.lock.tinker-new")) {
        throw new Error("EIO: simulated lock write");
      }
      return writeFileAsync(file, data, options);
    },
    async rename(from, to) {
      const back = String(from).endsWith("u.old") && String(to) === folder;
      if (back) throw new Error("SIGKILL: simulated death during the undo");
      return renameAsync(from, to);
    },
  };

  await expect(updateComponent(root, "u", registry, { fs })).rejects.toBeInstanceOf(Error);

  // Nothing was deleted in place: the new copy waits in .undo, the old one is whole in .old.
  expect(existsSync(join(root, ".tinker/update/u.undo/index.ts"))).toBe(true);
  expect(existsSync(join(root, ".tinker/update/u.old/index.ts"))).toBe(true);
  expect(existsSync(folder)).toBe(false);
  expect(read(root, lockPath)).toBe(lockBefore);

  const checked = tinker(root, "check", "--registry", registry);
  expect(checked.code).toBe(1);
  expect(checked.lines).toContain("interrupted update: u; run tinker update u");

  const run = tinker(root, "update", "u", "--registry", registry);
  expect(run.code).toBe(0);
  expect(run.lines[0]).toBe("restored tinker/components/u from an interrupted update");
  expect(existsSync(join(root, ".tinker/update"))).toBe(false);
  expect(lockOf(root).components.u.files["tinker/components/u/fresh.ts"]).toBe(
    shaFile(root, "tinker/components/u/fresh.ts"),
  );
});

test("N-badlockpath a lock that names a path outside the app is a finding", () => {
  const registry = makeRegistry();
  const root = app({
    ...items.c.files,
    [lockPath]: lockText({
      c: {
        files: {
          ...hashesOf(items.c.files, "tinker/components/c"),
          "../escape.txt": sha("escape"),
        },
        start: basePackage.version,
      },
    }),
  });

  const run = tinker(root, "check", "--registry", registry);

  expect(run.code).toBe(1);
  expect(run.lines).toEqual([
    "bad lock path: ../escape.txt",
    `outdated: c (lock start ${basePackage.version}; run tinker update c)`,
    "tinker check: 1 findings",
  ]);
});
