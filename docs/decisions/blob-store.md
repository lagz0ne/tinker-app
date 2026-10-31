# A blob store for the SQLite set

Date: 2026-10-31. Status: accepted.
Asked by: Hedl on Tinker, gap TG3 (#42).
Hedl is a 1:1 port of obelisk (fixtures at `000f8c7`).

## Context

Obelisk keeps file bytes in `lib/files.mjs`:

- `put(buf)`: SHA-256 of the bytes names the file
  `<data>/blobs/<2 hex>/<sha256>`. Written to a temp
  file, then renamed. No fsync. Same bytes: one file.
- `read(hash)`: the bytes, or `null`.
  A hash that is not 64 hex reads `null`.
- `slot(project, who)`: an upload slot,
  `up_<24 hex>`, one hour, 25 MB cap.
  Slots live in a `Map` and are lost on restart.
- `receive(id, buf, name)`: the `PUT` of a slot.
  Refuses unknown or expired, used, empty, too big.
- `take(id, project)`: hands the bytes over once,
  only to the project that asked.
- Bundles: each zip entry is `put` as its own blob.
  The zip reader has no cap on unpacked size.

Obelisk keeps report pictures in `lib/reports.mjs`
as `<id>.png` files beside the report, written in place.
In the port they become blobs: the report row keeps the hash.

## Precedent

- git and OCI name content by its SHA-256.
  The same bytes are stored once.
- S3 presigned `PUT`: a short-lived URL is the key.
  The client sends the bytes there, without sign-in.
- Maildir and SQLite's own journal: write a temp file,
  fsync it, rename it, fsync the folder.
  A reader sees the whole file or nothing.
- `docs/decisions/sqlite-variants.md`: a backend is a
  whole copy of a component with the same public names.
- zlib `maxOutputLength`: an inflate stops at a cap
  (the usual zip-bomb guard).

## Decision

A new component, `blobs-sqlite`, in the SQLite set.
It requires `errors` and `database-sqlite`.

Tags:

- `blobFolder`: the absolute folder for the bytes.
- `blobMaxBytes`: the default and top cap of
  one upload slot. Default 25 MiB (obelisk `MAX_UPLOAD`).
- `blobSlotTtl`: how long a slot lives, in ms.
  Default one hour (obelisk).
- `blobUnpackMax`: the most bytes a zip may unpack to,
  all entries together, and the top cap of `putBlob`.
  Default 100 MiB. Obelisk puts zip entries with no cap;
  the unpacked total bounds each one.
  The component does not read zips. Hedl's zip reader
  reads this tag and passes the bytes left as
  `maxOutputLength`.

Operations:

- `putBlob({ bytes })` gives `{ hash, size }`.
- `readBlob({ hash })` gives the bytes, or `undefined`.
- `openSlot({ owner, maxBytes? })` gives
  `{ id, expiresAt, maxBytes }`.
  The app builds the URL from `id`.
- `fillSlot({ id, body, name? })` reads a byte stream
  into the slot. It gives `{ id, hash, size }`.
- `takeSlot({ id, owner })` gives `{ hash, size, name }`
  once. The caller reads the bytes with `readBlob`.

Storage:

- Bytes: `<blobFolder>/<2 hex>/<sha256>`.
  Temp files: `<blobFolder>/tmp/`, on the same disk.
- Rows: `blob` (hash, size, time) and `blob_slot`
  in one SQLite migration.
- A blob row is written only after the file
  is renamed into place. The row is the truth:
  `readBlob` needs the row and the file.
- The write turn is held only for the row write,
  never while bytes stream in.
- A slot expires at open time + `blobSlotTtl`.
  Fill and take both refuse it then.
  `openSlot` deletes a slot row one more TTL later,
  so an expired slot reads `SlotExpired`, not missing.

The invariants and their tests are in the commit
that adds the component.

## Why these choices

- Slots move from a `Map` to rows: a slot survives
  a restart, and two processes share one store.
- `owner` is a plain string. Obelisk passes the project.
  The store does not know what a project is.
- Format sniffing stays in Hedl (`formatOf`).
  `name` rides on the slot so Hedl can sniff at take time.
- An S3 copy, `blobs-s3`, keeps the same public names.
  The byte side lives in one file of the component,
  so the copy replaces that file and `blobFolder`.
  With S3 the client sends bytes to S3, so that copy
  would add a `url` to the slot and check the bytes
  on take. Not built until an app asks.

## What Hedl changes

Found in review, against obelisk `000f8c7`:

- Take after expiry fails. Obelisk let a filled slot
  be taken until the next `slot()` pruned it.
  A PUT at 59:59 and `put_file` at 60:01 now fails.
  The ask was "a slot expires", so the store keeps it.
- `name` over 200 characters is refused.
  Hedl's PUT route slices it to 200 first, as obelisk did.
- `fillSlot` gives no format. Hedl reads the blob
  and runs `formatOf` for the PUT reply.
- A too-big stream stops before its full size is known.
  `BlobTooBig` names the cap, not the size.
  Hedl's message names the cap.
- `readBlob` gives a `Uint8Array`, not a `Buffer`.

## Not decided here

- Delete and garbage collection. Obelisk never
  deletes a blob; neither does this store.
  A fill that loses a race or expires at commit
  can leave a file with no row. It is never read.
- A Postgres `blobs` copy: on a second asker.
- A streaming read: on an asker. Obelisk reads
  whole buffers up to 25 MB.
