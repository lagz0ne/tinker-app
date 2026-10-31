import { resource, tag } from "@tinker/core";
import { z } from "zod";

import { raise } from "~/components/errors";

import { blobCrypto, blobFs, blobPath } from "./modules";
import { blobSlotTtl } from "./tags";

/** The absolute POSIX folder for the bytes. Temp files live in its `tmp/`, on the same disk. */
export const blobFolder = tag({
  label: "blobs.folder",
  parse: z.string().refine((path) => path.startsWith("/"), {
    error: "The blob folder needs an absolute POSIX path",
  }),
});

/** The two steps of one write. Not exported: only `blobBytes` uses them. */
const blobSteps = resource({
  label: "blobs.steps",
  depends: { folder: blobFolder, fs: blobFs, crypto: blobCrypto, path: blobPath },
  factory: async ({ folder, fs, crypto, path }) => ({
    /** Copy the stream into a new temp file, hashing as it goes, and fsync it before close. */
    async copy(
      reader: ReadableStreamDefaultReader<Uint8Array>,
      temp: string,
      maxBytes: number,
      signal: AbortSignal,
    ) {
      const hasher = crypto.createHash("sha256");

      const file = await fs.open(temp, "wx");

      let size = 0;

      try {
        while (true) {
          const chunk = await reader.read();

          signal.throwIfAborted();

          if (chunk.done) break;

          // A chunk with no byte length would slip past the cap.
          if (!(chunk.value instanceof Uint8Array)) raise("BlobNotBytes", {});

          size += chunk.value.byteLength;

          if (size > maxBytes) raise("BlobTooBig", { maxBytes });

          hasher.update(chunk.value);

          for (let offset = 0; offset < chunk.value.byteLength;) {
            offset += (await file.write(chunk.value, offset)).bytesWritten;
          }
        }

        if (size === 0) raise("BlobEmpty", {});

        await file.sync();
      } finally {
        await file.close();
      }

      return { hash: hasher.digest("hex"), size };
    },

    /** Rename a whole temp to its hash path; the same bytes already in place stay untouched. */
    async place(temp: string, hash: string) {
      const final = path.join(folder, hash.slice(0, 2), hash);

      const shelf = path.dirname(final);

      const present = await fs.stat(final).then(
        () => true,
        () => false,
      );

      if (present) {
        await fs.rm(temp, { force: true });
      } else {
        await fs.mkdir(shelf, { recursive: true });
        await fs.rename(temp, final);
      }

      // The file and its shelf are durable only once both folders are fsynced. A file that
      // was already there may be another writer's rename that is not fsynced yet.
      for (const dir of [shelf, folder]) {
        const handle = await fs.open(dir, "r");

        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    },
  }),
});

/**
 * The byte side of the store, the one part an S3 copy replaces: a file under
 * `<blobFolder>/<2 hex>/<sha256>` appears only by renaming a whole, fsynced temp.
 */
export const blobBytes = resource({
  label: "blobs.bytes",
  depends: {
    steps: blobSteps,
    folder: blobFolder,
    ttl: blobSlotTtl,
    fs: blobFs,
    crypto: blobCrypto,
    path: blobPath,
  },
  factory: async ({ steps, folder, ttl, fs, crypto, path }, { clock }) => {
    const temps = path.join(folder, "tmp");

    await fs.mkdir(temps, { recursive: true });

    // Crash leftovers go; a younger temp may be another process mid-write.
    for (const name of await fs.readdir(temps)) {
      const file = path.join(temps, name);

      const info = await fs.stat(file).catch(() => undefined);

      // The mtime is wall time from the disk; the scope clock matches it outside tests.
      if (info && info.mtimeMs < clock.currentTimeMillis() - ttl) {
        await fs.rm(file, { force: true });
      }
    }

    return {
      /**
       * Read `body` into a temp, stopping past `maxBytes` or at `signal`, then rename it into
       * place under its sha256. A failure removes the temp and cancels the body.
       */
      async write(body: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal) {
        signal.throwIfAborted();

        const temp = path.join(temps, crypto.randomBytes(12).toString("hex"));

        const reader = body.getReader();

        // A client that goes away ends the read now; the copy then throws the abort reason.
        const stop = () => void reader.cancel(signal.reason).catch(() => {});

        signal.addEventListener("abort", stop, { once: true });

        try {
          const stored = await steps.copy(reader, temp, maxBytes, signal);

          await steps.place(temp, stored.hash);

          return stored;
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          await fs.rm(temp, { force: true });

          throw error;
        } finally {
          signal.removeEventListener("abort", stop);
        }
      },

      /** The bytes stored under `hash`, or `undefined` when its file is gone. */
      async read(hash: string) {
        try {
          const buffer = await fs.readFile(path.join(folder, hash.slice(0, 2), hash));

          return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return undefined;
          }

          throw error;
        }
      },
    };
  },
});
