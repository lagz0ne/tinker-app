import { operation } from "@tinker/core";
import { z } from "zod";

import { database, transaction } from "~/components/database-sqlite/index.server";
import { raise } from "~/components/errors";

import { blobBytes } from "./bytes.server";
import { blobCrypto } from "./modules";
import deleteSlot from "./queries/delete_slot.sql";
import fillSlotQuery from "./queries/fill_slot.sql";
import insertBlob from "./queries/insert_blob.sql";
import insertSlot from "./queries/insert_slot.sql";
import pruneSlots from "./queries/prune_slots.sql";
import readBlobQuery from "./queries/read_blob.sql";
import readSlot from "./queries/read_slot.sql";
import { blobMaxBytes, blobSlotTtl, blobUnpackMax } from "./tags";

/** A blob's name: its sha256 as lower-case hex. Anything else never reaches the file system. */
const blobHash = /^[0-9a-f]{64}$/;

/** A slot id: `up_` and 12 random bytes as hex, as obelisk makes them. */
const slotId = /^up_[0-9a-f]{24}$/;

/**
 * Store `bytes` once under their sha256. The row is written after the file is in place. The cap
 * is `blobUnpackMax`: obelisk puts zip entries with no cap, and the unpacked total bounds them.
 */
export const putBlob = operation({
  label: "blobs.put",
  input: z.strictObject({ bytes: z.instanceof(Uint8Array) }),
  depends: { store: blobBytes, transaction, maxBytes: blobUnpackMax },
  run: async ({ store, transaction, maxBytes }, { input, clock, signal }) => {
    if (input.bytes.byteLength > maxBytes) raise("BlobTooBig", { maxBytes });

    if (input.bytes.byteLength === 0) raise("BlobEmpty", {});

    // The byte side reads one stream shape, so the whole buffer becomes a one-chunk stream.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(input.bytes);
        controller.close();
      },
    });

    const stored = await store.write(body, maxBytes, signal);

    insertBlob.runSync(await transaction.db(), {
      hash: stored.hash,
      size: stored.size,
      created_at: clock.currentTimeMillis(),
    });

    return stored;
  },
});

/** The bytes of a stored blob, or `undefined`: a blob needs its row and its file. */
export const readBlob = operation({
  label: "blobs.read",
  input: z.strictObject({ hash: z.string() }),
  depends: { database, store: blobBytes },
  run: async ({ database, store }, { input }) => {
    if (!blobHash.test(input.hash)) return undefined;

    if (!readBlobQuery.runSync(database.reader, { hash: input.hash })) return undefined;

    return store.read(input.hash);
  },
});

/**
 * Open an upload slot for `owner`. Slots expired for one more TTL are deleted in the same
 * transaction, so an expired slot reads SlotExpired, not SlotMissing, for that long.
 */
export const openSlot = operation({
  label: "blobs.openSlot",
  input: z.strictObject({
    owner: z.string().min(1).max(200),
    maxBytes: z.number().int().min(1).optional(),
  }),
  depends: { transaction, crypto: blobCrypto, limit: blobMaxBytes, ttl: blobSlotTtl },
  run: async ({ transaction, crypto, limit, ttl }, { input, clock }) => {
    const maxBytes = input.maxBytes ?? limit;

    if (maxBytes > limit) raise("BlobTooBig", { maxBytes: limit });

    const id = `up_${crypto.randomBytes(12).toString("hex")}`;

    const now = clock.currentTimeMillis();

    const expiresAt = now + ttl;

    const connection = await transaction.db();

    pruneSlots.runSync(connection, { now, ttl });

    insertSlot.runSync(connection, {
      id,
      owner: input.owner,
      max_bytes: maxBytes,
      expires_at: expiresAt,
    });

    return { id, expiresAt, maxBytes };
  },
});

/**
 * Read a byte stream into a slot. The bytes stream in with no write turn held; the slot is
 * filled by one conditional update, so of two fills only the first to commit wins.
 */
export const fillSlot = operation({
  label: "blobs.fillSlot",
  input: z.strictObject({
    id: z.string(),
    body: z.instanceof(ReadableStream<Uint8Array>),
    name: z.string().max(200).nullable().default(null),
  }),
  depends: { database, transaction, store: blobBytes },
  run: async ({ database, transaction, store }, { input, clock, signal }) => {
    if (!slotId.test(input.id)) raise("SlotMissing", {});

    const slot = readSlot.runSync(database.reader, { id: input.id });

    if (!slot) raise("SlotMissing", {});

    if (slot.hash !== null) raise("SlotUsed", {});

    if (clock.currentTimeMillis() >= slot.expires_at) raise("SlotExpired", {});

    const stored = await store.write(input.body, slot.max_bytes, signal);

    const connection = await transaction.db();

    const now = clock.currentTimeMillis();

    insertBlob.runSync(connection, { hash: stored.hash, size: stored.size, created_at: now });

    const filled = fillSlotQuery.runSync(connection, {
      id: input.id,
      hash: stored.hash,
      size: stored.size,
      name: input.name,
      filled_at: now,
      now,
    });

    if (!filled) {
      // The update found no open slot: say why. Only the prune of an expired slot deletes its
      // row while a fill streams, so a missing row reads as expired.
      const current = readSlot.runSync(connection, { id: input.id });

      if (current && current.hash !== null) raise("SlotUsed", {});

      raise("SlotExpired", {});
    }

    return { id: input.id, hash: stored.hash, size: stored.size };
  },
});

/** Hand a filled slot's blob to its owner once. The caller reads the bytes with `readBlob`. */
export const takeSlot = operation({
  label: "blobs.takeSlot",
  input: z.strictObject({ id: z.string(), owner: z.string().min(1).max(200) }),
  depends: { transaction },
  run: async ({ transaction }, { input, clock }) => {
    if (!slotId.test(input.id)) raise("SlotMissing", {});

    const connection = await transaction.db();

    const slot = readSlot.runSync(connection, { id: input.id });

    // Another owner reads the same as an unknown id: it does not learn the slot exists.
    if (!slot || slot.owner !== input.owner) raise("SlotMissing", {});

    if (clock.currentTimeMillis() >= slot.expires_at) raise("SlotExpired", {});

    if (slot.hash === null || slot.size === null) raise("SlotEmpty", {});

    deleteSlot.runSync(connection, { id: input.id });

    return { hash: slot.hash, size: slot.size, name: slot.name };
  },
});
