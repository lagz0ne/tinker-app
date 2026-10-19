import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";

import { readStart } from "./compression.mjs";

/** @typedef {Request & { runtime: { beforeEnd?: () => Promise<void> } }} Hosted - A request with the app's join. */

/**
 * The host writes each app body itself, as Fastify and Node do. A body done in the first turn,
 * within 64 KiB, goes out with its length in one `end()`; any other body streams as it arrives.
 * Before the end, the host awaits the join the app lends on `request.runtime.beforeEnd`, so a
 * request that cannot close fails its reply instead of ending it cleanly.
 * @param {Hosted} request - From the host; why: the app's join.
 * @param {Response} response - From the app, after compression; why: the head and the body to write.
 * @param {import("node:http").ServerResponse} outgoing - From hono; why: the Node response to write.
 */
export async function writeResponse(request, response, outgoing) {
  try {
    await writeBody(request, response, outgoing);
  } catch (error) {
    outgoing.destroy(error);
  }
  return RESPONSE_ALREADY_SENT;
}

/**
 * @param {Hosted} request - From writeResponse; why: the app's join.
 * @param {Response} response - From writeResponse; why: its body picks the path.
 * @param {import("node:http").ServerResponse} outgoing - From writeResponse; why: the write.
 */
async function writeBody(request, response, outgoing) {
  if (response.body === null) {
    await request.runtime.beforeEnd?.();
    outgoing.writeHead(response.status, outgoingHeaders(response.headers));
    outgoing.end();
    return;
  }

  const reader = response.body.getReader();
  const start = await readStart(reader);
  if (start.done) {
    const body = start.parts.length === 1 ? start.parts[0] : Buffer.concat(start.parts, start.size);
    await request.runtime.beforeEnd?.();
    outgoing.writeHead(response.status, outgoingHeaders(response.headers, body.byteLength));
    outgoing.end(body);
    return;
  }

  await writeStream(request, reader, response, start, outgoing);
}

/**
 * A client that leaves cancels the body, so a stream that waits for its next part ends too. The
 * head goes out at once, so a stream with no part yet still answers.
 * @param {Hosted} request - From writeBody; why: the app's join.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader - From writeBody; why: the rest of the body.
 * @param {Response} response - From writeBody; why: the head.
 * @param {{ parts: Uint8Array[], pending?: Promise<ReadableStreamReadResult<Uint8Array>> }} start - From readStart; why: the first parts go first, then the open read.
 * @param {import("node:http").ServerResponse} outgoing - From writeBody; why: each part as it arrives.
 */
async function writeStream(request, reader, response, { parts, pending }, outgoing) {
  const unwatch = cancelOnClose(reader, outgoing);
  outgoing.writeHead(response.status, outgoingHeaders(response.headers));
  for (const part of parts) outgoing.write(part);
  if (parts.length === 0) outgoing.flushHeaders();
  for (let part = await (pending ?? reader.read()); !part.done; part = await reader.read()) {
    if (!outgoing.write(part.value)) await drained(outgoing);
  }

  unwatch();
  if (outgoing.destroyed) return;

  await request.runtime.beforeEnd?.();
  outgoing.end();
}

/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader - From writeStream; why: a client that leaves cancels it.
 * @param {import("node:http").ServerResponse} outgoing - From writeStream; why: its close.
 */
function cancelOnClose(reader, outgoing) {
  const cancel = () => void reader.cancel().catch((error) => outgoing.destroy(error));
  if (outgoing.destroyed) cancel();
  else outgoing.once("close", cancel);
  return () => outgoing.off("close", cancel);
}

/** @param {import("node:http").ServerResponse} outgoing - From writeStream; why: wait for room, or for the client to leave. */
function drained(outgoing) {
  return new Promise((resolve) => {
    if (outgoing.destroyed) return resolve();

    const done = () => {
      outgoing.off("drain", done);
      outgoing.off("close", done);
      resolve();
    };
    outgoing.on("drain", done);
    outgoing.on("close", done);
  });
}

/**
 * @param {Headers} headers - From the app's response; why: Node takes a plain record.
 * @param {number} [length] - From a whole body; why: the exact length replaces chunked encoding.
 */
function outgoingHeaders(headers, length) {
  const record = {};
  for (const [name, value] of headers) if (name !== "set-cookie") record[name] = value;

  const cookies = headers.getSetCookie();
  if (cookies.length > 0) record["set-cookie"] = cookies;
  if (length !== undefined) record["content-length"] = length;
  return record;
}
