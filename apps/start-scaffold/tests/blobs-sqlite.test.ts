import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createScope, operation } from "@tinker/core";
import type { Scope } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { afterEach, expect, test } from "vite-plus/test";

import {
  blobFolder,
  blobMaxBytes,
  blobSlotTtl,
  blobUnpackMax,
  fillSlot,
  openSlot,
  putBlob,
  readBlob,
  takeSlot,
} from "~/components/blobs-sqlite/index.server";
import { blobFs } from "~/components/blobs-sqlite/modules";
import {
  database,
  databaseBusyTimeout,
  databaseMigrationTimeout,
  databaseMigrationsFolder,
  databaseUrl,
  migrate,
} from "~/components/database-sqlite/index.server";

import { write } from "./write-boundary";

const app = fileURLToPath(new URL("..", import.meta.url));

const homes: string[] = [];

const roots: Scope.Handle[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.close({ graceful: true });

  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

type Options = {
  home?: string;
  maxBytes?: number;
  unpackMax?: number;
  ttl?: number;
  now?: number;
  fs?: typeof import("node:fs/promises");
};

/** The blob limits a test binds; the others keep their defaults. */
function limitTags(options: Options) {
  return [
    options.maxBytes !== undefined && blobMaxBytes(options.maxBytes),
    options.unpackMax !== undefined && blobUnpackMax(options.unpackMax),
    options.ttl !== undefined && blobSlotTtl(options.ttl),
  ];
}

/** A migrated temp database and a temp blob folder; pass `home` for a second root on them. */
async function sandbox(options: Options = {}) {
  let home = options.home;

  if (!home) {
    home = await mkdtemp(join(tmpdir(), "tinker-blobs-sqlite-"));

    homes.push(home);

    await mkdir(join(home, "migrations"));

    for (const name of await readdir(join(app, "sqlite/migrations"))) {
      await writeFile(
        join(home, "migrations", name),
        await readFile(join(app, "sqlite/migrations", name), "utf8"),
      );
    }
  }

  const fs = options.fs;

  // Core's test clock; it starts at wall time so the crash clean-up can compare disk mtimes.
  const clock = makeTestClock({ now: options.now ?? Date.now() });

  const root = createScope({
    clock,
    tags: [
      databaseUrl(pathToFileURL(join(home, "app.db"))),
      databaseMigrationsFolder(join(home, "migrations")),
      databaseBusyTimeout(5000),
      databaseMigrationTimeout(10_000),
      blobFolder(join(home, "blobs")),
      ...limitTags(options),
    ],
    presets: fs ? [preset(blobFs, async () => fs)] : [],
  });

  roots.push(root);

  await root.run(migrate);

  return { root, home, clock, folder: join(home, "blobs") };
}

const encoder = new TextEncoder();

function bytesOf(text: string) {
  return encoder.encode(text);
}

function randomBytesOf(length: number) {
  return new Uint8Array(randomBytes(length));
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A hand-fed body: the test enqueues chunks, ends, or errors it. `waiting()` resolves when the
 * reader asks for the next chunk, so a test knows the fill is paused mid-stream.
 */
function feed() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let pulled = Promise.withResolvers<void>();
  let pulls = 0;
  let cancelled = false;

  const body = new ReadableStream<Uint8Array>(
    {
      start(control) {
        controller = control;
      },
      pull() {
        pulls++;
        pulled.resolve();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );

  return {
    body,
    async waiting() {
      await pulled.promise;

      pulled = Promise.withResolvers<void>();
    },
    push(bytes: Uint8Array) {
      controller.enqueue(bytes);
    },
    end() {
      controller.close();
    },
    fail(error: unknown) {
      controller.error(error);
    },
    pulls: () => pulls,
    cancelled: () => cancelled,
  };
}

/** A body that already holds every chunk and then ends. */
function bodyOf(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);

      controller.close();
    },
  });
}

/** Start a fill and wait until it has read `first` and is paused for more. */
async function pausedFill(root: Scope.Handle, id: string, first: Uint8Array, signal?: AbortSignal) {
  const body = feed();

  const result = write(root, fillSlot, {
    rawInput: { id, body: body.body, name: "photo.png" },
    signal,
  });

  // A refusal before the body is read must not leave an unhandled rejection behind.
  result.catch(() => {});

  await body.waiting();
  body.push(first);
  await body.waiting();

  return { body, result };
}

/** Every stored blob file, as `<2 hex>/<hash>` paths; temp files are not blobs. */
async function blobFiles(folder: string) {
  const files: string[] = [];

  for (const prefix of await readdir(folder).catch(() => [])) {
    if (prefix === "tmp") continue;

    for (const name of await readdir(join(folder, prefix))) files.push(`${prefix}/${name}`);
  }

  return files.sort();
}

async function tempFiles(folder: string) {
  return readdir(join(folder, "tmp")).catch(() => []);
}

async function blobRows(root: Scope.Handle) {
  const db = await root.resolve(database);

  return db.reader.prepare("SELECT hash, size FROM blob ORDER BY hash").all();
}

async function slotRow(root: Scope.Handle, id: string) {
  const db = await root.resolve(database);

  return db.reader.prepare("SELECT hash, size, name FROM blob_slot WHERE id = ?").get(id);
}

async function open(root: Scope.Handle, owner = "project-1", maxBytes?: number) {
  return write(root, openSlot, {
    rawInput: maxBytes === undefined ? { owner } : { owner, maxBytes },
  });
}

async function fill(root: Scope.Handle, id: string, bytes: Uint8Array, name = "photo.png") {
  return write(root, fillSlot, { rawInput: { id, body: bodyOf(bytes), name } });
}

async function take(root: Scope.Handle, id: string, owner = "project-1") {
  return write(root, takeSlot, { rawInput: { id, owner } });
}

async function put(root: Scope.Handle, bytes: Uint8Array) {
  return write(root, putBlob, { rawInput: { bytes } });
}

async function read(root: Scope.Handle, hash: string) {
  return write(root, readBlob, { rawInput: { hash } });
}

/** The real `node:fs/promises`, with each call and each file handle call written to `log`. */
async function recordingFs(log: unknown[][], probe: (entry: unknown[]) => void) {
  const fs = await import("node:fs/promises");

  const wrapHandle = (handle: FileHandle, path: string) =>
    new Proxy(handle, {
      get(target, key) {
        const value = Reflect.get(target, key, target);

        if (typeof value !== "function") return value;

        return (...args: unknown[]) => {
          const entry = [`handle.${String(key)}`, path];

          log.push(entry);
          probe(entry);

          return Reflect.apply(value, target, args);
        };
      },
    });

  return new Proxy(fs, {
    get(target, key) {
      const value = Reflect.get(target, key, target);

      if (typeof value !== "function") return value;

      return async (...args: unknown[]) => {
        const entry = [String(key), ...args.filter((arg) => typeof arg === "string")];

        log.push(entry);
        probe(entry);

        if (key === "open") {
          return wrapHandle(
            await fs.open(...(args as Parameters<typeof fs.open>)),
            String(args[0]),
          );
        }

        return Reflect.apply(value, target, args);
      };
    },
  }) as typeof fs;
}

// I1: whole or nothing.

test("I1: a blob file appears only by renaming a fully written, fsynced temp; the folder is fsynced before the row", async () => {
  const log: unknown[][] = [];

  const rowsAt = new Map<unknown[], number>();

  const home = await mkdtemp(join(tmpdir(), "tinker-blobs-sqlite-"));

  homes.push(home);

  const { DatabaseSync } = await import("node:sqlite");

  let peek: InstanceType<typeof DatabaseSync> | undefined;

  const fs = await recordingFs(log, (entry) => {
    if (!peek) return;

    rowsAt.set(entry, Number(peek.prepare("SELECT count(*) AS n FROM blob").get()?.n));
  });

  await mkdir(join(home, "migrations"));

  for (const name of await readdir(join(app, "sqlite/migrations"))) {
    await writeFile(
      join(home, "migrations", name),
      await readFile(join(app, "sqlite/migrations", name), "utf8"),
    );
  }

  const { root, folder } = await sandbox({ home, fs });

  peek = new DatabaseSync(join(home, "app.db"));

  const bytes = bytesOf("whole or nothing");

  const hash = sha256(bytes);

  const final = join(folder, hash.slice(0, 2), hash);

  const { hash: stored } = await put(root, bytes);

  expect(stored).toBe(hash);

  const renameAt = log.findIndex((entry) => entry[0] === "rename" && entry[2] === final);

  expect(renameAt).toBeGreaterThan(-1);

  const temp = log[renameAt]?.[1];

  expect(dirname(String(temp))).toBe(join(folder, "tmp"));

  const syncAt = log.findIndex((entry) => entry[0] === "handle.sync" && entry[1] === temp);

  const writeAt = log.findLastIndex((entry) => entry[0] === "handle.write" && entry[1] === temp);

  const closeAt = log.findIndex((entry) => entry[0] === "handle.close" && entry[1] === temp);

  const folderSyncAt = log.findIndex(
    (entry, index) =>
      index > renameAt && entry[0] === "handle.sync" && entry[1] === join(folder, hash.slice(0, 2)),
  );

  expect(writeAt).toBeGreaterThan(-1);
  expect(writeAt).toBeLessThan(syncAt);
  expect(syncAt).toBeLessThan(closeAt);
  expect(closeAt).toBeLessThan(renameAt);
  // A new shelf is an entry in blobFolder, so blobFolder is fsynced too.
  const rootSyncAt = log.findIndex(
    (entry, index) => index > renameAt && entry[0] === "handle.sync" && entry[1] === folder,
  );

  expect(folderSyncAt).toBeGreaterThan(renameAt);
  expect(rootSyncAt).toBeGreaterThan(renameAt);

  // The row is not there when the file lands, nor when the folders are fsynced.
  expect(rowsAt.get(log[renameAt]!)).toBe(0);
  expect(rowsAt.get(log[folderSyncAt]!)).toBe(0);
  expect(rowsAt.get(log[rootSyncAt]!)).toBe(0);

  expect(await blobRows(root)).toEqual([{ hash, size: bytes.length }]);

  peek.close();
});

test("I1: readBlob needs the row as well as the file", async () => {
  const { root, folder } = await sandbox();

  const bytes = bytesOf("a file with no row");

  const hash = sha256(bytes);

  await mkdir(join(folder, hash.slice(0, 2)), { recursive: true });
  await writeFile(join(folder, hash.slice(0, 2), hash), bytes);

  expect(await read(root, hash)).toBeUndefined();
});

// I2: same bytes once.

test("I2: two puts and a fill of the same bytes give one hash, one row, one file, never rewritten", async () => {
  const { root, folder } = await sandbox();

  const bytes = bytesOf("same bytes once");

  const first = await put(root, bytes);

  const path = join(folder, first.hash.slice(0, 2), first.hash);

  const before = await stat(path);

  const second = await put(root, bytes);

  const slot = await open(root);

  const filled = await fill(root, slot.id, bytes);

  const after = await stat(path);

  expect(second).toEqual(first);
  expect(filled).toEqual({ id: slot.id, hash: first.hash, size: bytes.length });
  expect(await blobRows(root)).toEqual([{ hash: first.hash, size: bytes.length }]);
  expect(await blobFiles(folder)).toEqual([`${first.hash.slice(0, 2)}/${first.hash}`]);
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
});

// I3: hash is honest.

test("I3: every stored blob reads back as bytes whose sha256 and length match its hash and size", async () => {
  const { root } = await sandbox();

  const samples = [new Uint8Array([7]), randomBytesOf(1000), randomBytesOf(65_536)];

  for (const bytes of samples) {
    const { hash, size } = await put(root, bytes);

    const back = await read(root, hash);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(size).toBe(bytes.length);
    expect(sha256(back!)).toBe(hash);
    expect(back!.length).toBe(size);
  }

  // A fill fed in many chunks hashes the whole stream, not one chunk.
  const big = randomBytesOf(70_000);

  const chunks = Array.from({ length: 7 }, (_, index) =>
    big.subarray(index * 10_000, (index + 1) * 10_000),
  );

  const slot = await open(root);

  const filled = await write(root, fillSlot, {
    rawInput: { id: slot.id, body: bodyOf(...chunks) },
  });

  expect(filled.hash).toBe(sha256(big));
  expect(filled.size).toBe(big.length);
  expect(sha256((await read(root, filled.hash))!)).toBe(filled.hash);
});

// I4: read is safe.

test("I4: a hash that is not 64 lower-case hex reads undefined without touching the file system", async () => {
  const log: unknown[][] = [];

  const fs = await recordingFs(log, () => {});

  const { root } = await sandbox({ fs });

  const { hash } = await put(root, bytesOf("safe read"));

  log.length = 0;

  for (const bad of ["../x", hash.toUpperCase(), hash.slice(0, 63), `${hash}0`, ""]) {
    expect(await read(root, bad)).toBeUndefined();
  }

  expect(log).toEqual([]);
});

test("I4: an unknown hash, and a row whose file is gone, read undefined", async () => {
  const { root, folder } = await sandbox();

  expect(await read(root, sha256(bytesOf("never stored")))).toBeUndefined();

  const { hash } = await put(root, bytesOf("lost file"));

  await rm(join(folder, hash.slice(0, 2), hash));

  expect(await read(root, hash)).toBeUndefined();
});

// I5: slot expires.

test("I5: a slot expires at open time + blobSlotTtl; fill is refused before reading the body, take too", async () => {
  const { root, clock } = await sandbox({ ttl: 1000, now: 1_000_000 });

  const slot = await open(root);

  expect(slot.expiresAt).toBe(1_001_000);

  const filled = await open(root);

  await fill(root, filled.id, bytesOf("filled in time"));

  clock.setTime(1_000_999);

  const late = await open(root);

  clock.setTime(1_001_000);

  const body = feed();

  await expect(
    write(root, fillSlot, { rawInput: { id: slot.id, body: body.body } }),
  ).rejects.toMatchObject({ kind: "SlotExpired" });

  expect(body.pulls()).toBe(0);

  await expect(take(root, slot.id)).rejects.toMatchObject({ kind: "SlotExpired" });
  await expect(take(root, filled.id)).rejects.toMatchObject({ kind: "SlotExpired" });

  // One ms before its own expiry a slot still works.
  expect(await fill(root, late.id, bytesOf("just in time"))).toMatchObject({ id: late.id });
});

// I6: cap per slot.

test("I6: openSlot maxBytes defaults to blobMaxBytes and may not pass it", async () => {
  const { root } = await sandbox({ maxBytes: 64 });

  expect(await open(root)).toMatchObject({ maxBytes: 64 });
  expect(await open(root, "project-1", 10)).toMatchObject({ maxBytes: 10 });

  await expect(open(root, "project-1", 65)).rejects.toMatchObject({
    kind: "BlobTooBig",
    payload: { maxBytes: 64 },
  });
});

test("I6: a fill stops reading past the slot cap, cancels the body, and leaves the slot open and empty", async () => {
  const { root, folder } = await sandbox({ maxBytes: 64 });

  const slot = await open(root, "project-1", 8);

  const body = feed();

  const result = write(root, fillSlot, { rawInput: { id: slot.id, body: body.body } });

  result.catch(() => {});

  await body.waiting();
  body.push(bytesOf("12345"));
  await body.waiting();
  body.push(bytesOf("67890"));

  await expect(result).rejects.toMatchObject({ kind: "BlobTooBig", payload: { maxBytes: 8 } });

  expect(body.pulls()).toBe(2);
  expect(body.cancelled()).toBe(true);
  expect(await blobFiles(folder)).toEqual([]);
  expect(await tempFiles(folder)).toEqual([]);
  expect(await blobRows(root)).toEqual([]);
  expect(await slotRow(root, slot.id)).toEqual({ hash: null, size: null, name: null });

  expect(await fill(root, slot.id, bytesOf("12345678"))).toMatchObject({ size: 8 });
});

test("I6: putBlob caps at blobUnpackMax, not blobMaxBytes", async () => {
  const { root, folder } = await sandbox({ maxBytes: 10, unpackMax: 20 });

  // A zip entry may pass the slot cap: obelisk puts entries with no cap.
  expect(await put(root, new Uint8Array(11).fill(1))).toMatchObject({ size: 11 });
  expect(await put(root, new Uint8Array(20).fill(2))).toMatchObject({ size: 20 });

  await expect(put(root, new Uint8Array(21))).rejects.toMatchObject({
    kind: "BlobTooBig",
    payload: { maxBytes: 20 },
  });

  expect(await blobFiles(folder)).toHaveLength(2);
});

// I7: empty refused.

test("I7: an empty fill and an empty put are refused; the slot stays open", async () => {
  const { root, folder } = await sandbox();

  const slot = await open(root);

  await expect(
    write(root, fillSlot, { rawInput: { id: slot.id, body: bodyOf() } }),
  ).rejects.toMatchObject({ kind: "BlobEmpty" });

  await expect(put(root, new Uint8Array(0))).rejects.toMatchObject({ kind: "BlobEmpty" });

  expect(await blobRows(root)).toEqual([]);
  expect(await tempFiles(folder)).toEqual([]);
  expect(await fill(root, slot.id, bytesOf("now with bytes"))).toMatchObject({ id: slot.id });
});

// I8: one use.

test("I8: a filled slot refuses a second fill; take is once, only for its owner, and only when filled", async () => {
  const { root } = await sandbox();

  const slot = await open(root);

  await expect(take(root, slot.id)).rejects.toMatchObject({ kind: "SlotEmpty" });

  const bytes = bytesOf("one use");

  await fill(root, slot.id, bytes, "notes.txt");

  await expect(fill(root, slot.id, bytesOf("again"))).rejects.toMatchObject({ kind: "SlotUsed" });

  await expect(take(root, slot.id, "project-2")).rejects.toMatchObject({ kind: "SlotMissing" });

  expect(await take(root, slot.id)).toEqual({
    hash: sha256(bytes),
    size: bytes.length,
    name: "notes.txt",
  });

  await expect(take(root, slot.id)).rejects.toMatchObject({ kind: "SlotMissing" });
  expect(await slotRow(root, slot.id)).toBeUndefined();
});

test("I8: a fill with no name takes back a null name", async () => {
  const { root } = await sandbox();

  const slot = await open(root);

  await write(root, fillSlot, { rawInput: { id: slot.id, body: bodyOf(bytesOf("nameless")) } });

  expect(await take(root, slot.id)).toMatchObject({ name: null });
});

test("inputs: a bad or unknown id is SlotMissing; owner, name and maxBytes are checked at the seam", async () => {
  const { root } = await sandbox();

  for (const id of ["nope", "up_XYZ", `up_${"0".repeat(24)}`, "../up_0"]) {
    await expect(fill(root, id, bytesOf("x"))).rejects.toMatchObject({ kind: "SlotMissing" });
    await expect(take(root, id)).rejects.toMatchObject({ kind: "SlotMissing" });
  }

  await expect(open(root, "")).rejects.toThrow();
  await expect(open(root, "o".repeat(201))).rejects.toThrow();
  await expect(open(root, "project-1", 0)).rejects.toThrow();
  await expect(open(root, "project-1", 1.5)).rejects.toThrow();

  const slot = await open(root, "o".repeat(200));

  expect(slot.id).toMatch(/^up_[0-9a-f]{24}$/);

  await expect(fill(root, slot.id, bytesOf("x"), "n".repeat(201))).rejects.toThrow();

  expect(await fill(root, slot.id, bytesOf("x"), "n".repeat(200))).toMatchObject({ size: 1 });
});

// I9: failed fill leaves nothing.

test("I9: a body that errors mid-stream rethrows its error and leaves the slot open and empty", async () => {
  const { root, folder } = await sandbox();

  const slot = await open(root);

  const { body, result } = await pausedFill(root, slot.id, bytesOf("half of it"));

  const boom = new Error("the client broke the stream");

  body.fail(boom);

  await expect(result).rejects.toBe(boom);

  expect(await tempFiles(folder)).toEqual([]);
  expect(await blobFiles(folder)).toEqual([]);
  expect(await blobRows(root)).toEqual([]);
  expect(await slotRow(root, slot.id)).toEqual({ hash: null, size: null, name: null });
  expect(await fill(root, slot.id, bytesOf("whole"))).toMatchObject({ id: slot.id });
});

test("I9: an abort mid-stream rethrows the abort reason, cancels the body, and leaves nothing", async () => {
  const { root, folder } = await sandbox();

  const slot = await open(root);

  const stop = new AbortController();

  const { body, result } = await pausedFill(root, slot.id, bytesOf("half of it"), stop.signal);

  const gone = new DOMException("The client went away", "AbortError");

  stop.abort(gone);

  await expect(result).rejects.toBe(gone);

  expect(body.cancelled()).toBe(true);
  expect(await tempFiles(folder)).toEqual([]);
  expect(await blobFiles(folder)).toEqual([]);
  expect(await blobRows(root)).toEqual([]);
  expect(await slotRow(root, slot.id)).toEqual({ hash: null, size: null, name: null });
  expect(await fill(root, slot.id, bytesOf("whole"))).toMatchObject({ id: slot.id });
});

test("a body chunk that is not bytes is BlobNotBytes and leaves the slot open and empty", async () => {
  const { root, folder } = await sandbox();

  const slot = await open(root);

  const text = new ReadableStream<string>({
    start(controller) {
      controller.enqueue("not bytes");
      controller.close();
    },
  });

  await expect(
    write(root, fillSlot, { rawInput: { id: slot.id, body: text } }),
  ).rejects.toMatchObject({ kind: "BlobNotBytes" });

  expect(await tempFiles(folder)).toEqual([]);
  expect(await blobRows(root)).toEqual([]);
  expect(await slotRow(root, slot.id)).toEqual({ hash: null, size: null, name: null });
});

// I10: the slot survives a restart.

test("I10: a slot opened in one root is filled and taken in a new root on the same file and folder", async () => {
  const first = await sandbox();

  const slot = await open(first.root);

  await first.root.close({ graceful: true });

  const second = await sandbox({ home: first.home });

  const bytes = bytesOf("after a restart");

  expect(await fill(second.root, slot.id, bytes)).toEqual({
    id: slot.id,
    hash: sha256(bytes),
    size: bytes.length,
  });

  expect(await take(second.root, slot.id)).toMatchObject({ hash: sha256(bytes) });
  expect(await read(second.root, sha256(bytes))).toEqual(bytes);
});

test("a new root removes temp files older than blobSlotTtl and keeps younger ones", async () => {
  const first = await sandbox({ ttl: 60_000 });

  await put(first.root, bytesOf("start the folder"));
  await first.root.close({ graceful: true });

  const old = join(first.folder, "tmp", "crashed");

  const young = join(first.folder, "tmp", "writing");

  await writeFile(old, "left by a crash");
  await writeFile(young, "another process mid-write");

  const past = new Date(Date.now() - 120_000);

  await utimes(old, past, past);

  const second = await sandbox({ home: first.home, ttl: 60_000 });

  await put(second.root, bytesOf("wake the store"));

  expect(await tempFiles(second.folder)).toEqual(["writing"]);
});

// Named interleavings.

test.each([
  ["the same bytes", "racing bytes", "racing bytes"],
  ["different bytes", "fill one", "fill two"],
])(
  "A: two fills race on one slot with %s; the first commit wins, the second is SlotUsed",
  async (_, one, two) => {
    const { root } = await sandbox();

    const slot = await open(root);

    const fill1 = await pausedFill(root, slot.id, bytesOf(one));

    const fill2 = await pausedFill(root, slot.id, bytesOf(two));

    fill1.body.end();

    const hash1 = sha256(bytesOf(one));

    expect(await fill1.result).toEqual({ id: slot.id, hash: hash1, size: bytesOf(one).length });

    fill2.body.end();

    await expect(fill2.result).rejects.toMatchObject({ kind: "SlotUsed" });

    expect(await slotRow(root, slot.id)).toMatchObject({ hash: hash1 });
    expect(await take(root, slot.id)).toMatchObject({ hash: hash1 });
  },
);

test("B: a fill that starts before expiry and ends after it is SlotExpired, and so is take", async () => {
  const { root, folder, clock } = await sandbox({ ttl: 1000, now: 5_000_000 });

  const slot = await open(root);

  const { body, result } = await pausedFill(root, slot.id, bytesOf("too slow"));

  clock.setTime(slot.expiresAt);

  body.end();

  await expect(result).rejects.toMatchObject({ kind: "SlotExpired" });
  await expect(take(root, slot.id)).rejects.toMatchObject({ kind: "SlotExpired" });
  expect(await slotRow(root, slot.id)).toEqual({ hash: null, size: null, name: null });
  expect(await tempFiles(folder)).toEqual([]);
});

test("B: a fill whose slot is pruned mid-stream is SlotExpired", async () => {
  const { root, clock } = await sandbox({ ttl: 1000, now: 5_000_000 });

  const slot = await open(root);

  const { body, result } = await pausedFill(root, slot.id, bytesOf("pruned under me"));

  // One more TTL past expiry: the next openSlot deletes the row while the fill streams.
  clock.setTime(slot.expiresAt + 1000);

  await open(root);

  expect(await slotRow(root, slot.id)).toBeUndefined();

  body.end();

  await expect(result).rejects.toMatchObject({ kind: "SlotExpired" });
});

test("openSlot prunes a slot only one TTL after it expired; until then take is SlotExpired", async () => {
  const { root, clock } = await sandbox({ ttl: 1000, now: 7_000_000 });

  const slot = await open(root);

  clock.setTime(slot.expiresAt + 999);

  await open(root);

  expect(await slotRow(root, slot.id)).toEqual({ hash: null, size: null, name: null });
  await expect(take(root, slot.id)).rejects.toMatchObject({ kind: "SlotExpired" });

  clock.setTime(slot.expiresAt + 1000);

  await open(root);

  expect(await slotRow(root, slot.id)).toBeUndefined();
  await expect(take(root, slot.id)).rejects.toMatchObject({ kind: "SlotMissing" });
});

test("C: take during a fill is SlotEmpty; after the fill commits, take gives the blob", async () => {
  const { root } = await sandbox();

  const slot = await open(root);

  const { body, result } = await pausedFill(root, slot.id, bytesOf("mid-stream"));

  await expect(take(root, slot.id)).rejects.toMatchObject({ kind: "SlotEmpty" });

  body.end();

  await result;

  expect(await take(root, slot.id)).toEqual({
    hash: sha256(bytesOf("mid-stream")),
    size: bytesOf("mid-stream").length,
    name: "photo.png",
  });
});

test("D: two puts of the same bytes at once give the same hash, one row, one file", async () => {
  const { root, folder } = await sandbox();

  const bytes = randomBytesOf(200_000);

  const [one, two] = await Promise.all([put(root, bytes), put(root, bytes)]);

  expect(one).toEqual({ hash: sha256(bytes), size: bytes.length });
  expect(two).toEqual(one);
  expect(await blobRows(root)).toEqual([one]);
  expect(await blobFiles(folder)).toEqual([`${one.hash.slice(0, 2)}/${one.hash}`]);
  expect(new Uint8Array(await readFile(join(folder, one.hash.slice(0, 2), one.hash)))).toEqual(
    bytes,
  );
  expect(await tempFiles(folder)).toEqual([]);
});

test("E: readBlob during a fill of those bytes is undefined; after commit it is the bytes", async () => {
  const { root } = await sandbox();

  const bytes = bytesOf("not yet");

  const slot = await open(root);

  const { body, result } = await pausedFill(root, slot.id, bytes);

  expect(await read(root, sha256(bytes))).toBeUndefined();

  body.end();

  await result;

  expect(await read(root, sha256(bytes))).toEqual(bytes);
});

test("F: two takes of one filled slot at once give exactly one result; the other is SlotMissing", async () => {
  const { root } = await sandbox();

  const slot = await open(root);

  await fill(root, slot.id, bytesOf("only once"));

  const settled = await Promise.allSettled([take(root, slot.id), take(root, slot.id)]);

  const won = settled.filter((result) => result.status === "fulfilled");

  const lost = settled.filter((result) => result.status === "rejected");

  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect(lost[0]?.reason).toMatchObject({ kind: "SlotMissing" });
});

test("G: two roots fill two slots with the same bytes at once; one hash, one row, one file", async () => {
  const first = await sandbox();

  const second = await sandbox({ home: first.home });

  const slot1 = await open(first.root);

  const slot2 = await open(second.root);

  const bytes = bytesOf("two processes, one blob");

  const fill1 = await pausedFill(first.root, slot1.id, bytes);

  const fill2 = await pausedFill(second.root, slot2.id, bytes);

  fill1.body.end();
  fill2.body.end();

  const [one, two] = await Promise.all([fill1.result, fill2.result]);

  expect(one).toEqual({ id: slot1.id, hash: sha256(bytes), size: bytes.length });
  expect(two).toEqual({ id: slot2.id, hash: sha256(bytes), size: bytes.length });
  expect(await blobRows(first.root)).toEqual([{ hash: sha256(bytes), size: bytes.length }]);
  expect(await blobFiles(first.folder)).toEqual([`${one.hash.slice(0, 2)}/${one.hash}`]);
});

test("H: a paused fill does not block openSlot or putBlob in the same root", async () => {
  const { root } = await sandbox();

  const slot = await open(root);

  const { body, result } = await pausedFill(root, slot.id, bytesOf("paused"));

  expect(await open(root)).toMatchObject({ id: expect.stringMatching(/^up_/) });
  expect(await put(root, bytesOf("beside the fill"))).toMatchObject({ size: 15 });

  body.end();

  expect(await result).toMatchObject({ id: slot.id });
});

// Tags.

test("the blob tags have their defaults, and a test can bind blobUnpackMax", async () => {
  const limits = operation({
    label: "proof.blobLimits",
    depends: { max: blobMaxBytes, ttl: blobSlotTtl, unpack: blobUnpackMax },
    run: async ({ max, ttl, unpack }) => ({ max, ttl, unpack }),
  });

  const plain = createScope({ tags: [] });

  roots.push(plain);

  expect(await plain.run(limits)).toEqual({
    max: 26_214_400,
    ttl: 3_600_000,
    unpack: 104_857_600,
  });

  const bound = createScope({ tags: [blobUnpackMax(5)] });

  roots.push(bound);

  expect(await bound.run(limits)).toMatchObject({ unpack: 5 });

  expect(() => blobUnpackMax(0)).toThrow();

  // The folder fsync opens a folder, which POSIX allows: only POSIX absolute paths bind.
  expect(() => blobFolder("C:\\blobs")).toThrow();
  expect(() => blobFolder("blobs")).toThrow();
  expect(() => blobFolder("/srv/blobs")).not.toThrow();
});
