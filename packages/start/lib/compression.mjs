import { Readable } from "node:stream";
import { promisify } from "node:util";
import { brotliCompress, createBrotliCompress, createGzip, gzip, constants } from "node:zlib";

const streams = {
  br: () =>
    createBrotliCompress({
      flush: constants.BROTLI_OPERATION_FLUSH,
      params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
    }),
  gzip: () => createGzip({ flush: constants.Z_SYNC_FLUSH }),
};

const compressibleType = /^(text\/(javascript|css|html)|application\/javascript)(;|$)/i;
const noTransform = /\bno-transform\b/i;
const varySeparator = /\s*,\s*/;
const encodings = new Map();

const encoders = { br: promisify(brotliCompress), gzip: promisify(gzip) };

/** Up to this many bytes a finished body is compressed whole, the way nginx buffers a short proxied reply. */
const shortBody = 65536;

/**
 * Explicit q=0 wins over a wildcard; ties prefer Brotli.
 * @param {string} accepted - From the header; why: validate outside encoding weights once.
 */
function readWeights(accepted) {
  const weights = new Map();
  for (const token of accepted.split(",")) {
    const [name, ...parameters] = token.trim().toLowerCase().split(";");
    weights.set(name, readWeight(parameters));
  }
  return weights;
}

/** @param {string[]} parameters - From a header token; why: invalid weights refuse that encoding. */
function readWeight(parameters) {
  const quality = parameters.find(isQuality);
  const weight = quality === undefined ? 1 : Number(quality.trim().slice(2));
  return Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0;
}

/** @param {string} parameter - From the header; why: ignore unrelated token parameters. */
function isQuality(parameter) {
  return parameter.trim().startsWith("q=");
}

/** @param {Request} request - From the host; why: pick the highest accepted weight, with Brotli winning ties. */
export function readEncoding(request) {
  const accepted = request.headers.get("accept-encoding") ?? "";
  if (encodings.has(accepted)) return encodings.get(accepted);

  const encoding = selectEncoding(accepted);
  if (encodings.size === 128) encodings.clear();
  encodings.set(accepted, encoding);
  return encoding;
}

/** @param {string} accepted - From the header; why: only a new header needs weight parsing. */
function selectEncoding(accepted) {
  const weights = readWeights(accepted);
  const fallback = weights.get("*") ?? 0;
  const choices = ["br", "gzip"].map((name) => ({ name, weight: weights.get(name) ?? fallback }));
  choices.push({ name: "identity", weight: weights.get("identity") ?? 0 });

  const best = choices.sort((a, b) => b.weight - a.weight).find(({ weight }) => weight > 0);
  if (best) return best.name;

  const identity = weights.get("identity") ?? Number(weights.get("*") !== 0);
  return identity > 0 ? "identity" : null;
}

/** @param {string} type - From a file or response; why: only JS, CSS, and HTML are compressed. */
export function isCompressible(type) {
  return compressibleType.test(type);
}

/**
 * @param {Uint8Array | string} bytes - From the build or a built file; why: its encoded copy.
 * @param {"br" | "gzip"} encoding - From negotiation or the build; why: the wire format.
 * @param {number} quality - From the build; why: use 11 off the request path, 4 while serving.
 */
export function compressBytes(bytes, encoding, quality = 4) {
  return encoding === "br"
    ? encoders.br(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } })
    : encoders.gzip(bytes);
}

/**
 * @param {Response} response - From the app; why: encoded and partial bodies must pass through.
 */
function mayCompress(response) {
  if (!isCompressible(response.headers.get("content-type") ?? "")) return false;
  if (response.headers.has("content-encoding") || response.status === 206) return false;
  return !noTransform.test(response.headers.get("cache-control") ?? "");
}

/** @param {Headers} headers - From a response; why: merge the encoding cache key without repeating it. */
export function varyEncoding(headers) {
  const vary = headers.get("vary") ?? "";
  if (vary === "*" || vary.toLowerCase().split(varySeparator).includes("accept-encoding")) return;
  headers.set("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
}

/**
 * A plain body needs only the cache key, so the app's response is kept when its headers can change.
 * @param {Request} request - From the host; why: HEAD still drops the body through a copy.
 * @param {Response} response - From the app; why: immutable headers (fetch) fall back to the copy, which sets Vary again.
 * @param {string | null} encoding - From negotiation; why: only identity keeps the original body.
 */
function varyPlain(request, response, encoding) {
  if (encoding !== "identity" || request.method === "HEAD") return false;
  try {
    varyEncoding(response.headers);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep HTML streaming; the encoded stream owns errors and cancellation.
 * @param {Request} request - From the host; why: encoding and HEAD semantics.
 * @param {Response} response - From the app; why: retain its body until consumed or cancelled.
 */
export async function compressResponse(request, response) {
  if (!mayCompress(response)) return response;
  const encoding = readEncoding(request);
  if (varyPlain(request, response, encoding)) return response;

  const headers = new Headers(response.headers);
  varyEncoding(headers);

  if (encoding === null) {
    await response.body?.cancel();
    headers.delete("content-length");
    headers.delete("etag");
    return new Response(null, { status: 406, headers });
  }

  if (encoding !== "identity" && (response.body !== null || request.method === "HEAD")) {
    headers.set("content-encoding", encoding);
    headers.delete("content-length");
    headers.delete("etag");
  }

  const body = await compressBody(request, response.body, encoding, headers);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * A finished short body is compressed in one call; a body still open after one turn of the event
 * loop keeps streaming, so the HTML shell is not held back.
 * @param {Request} request - From the host; why: HEAD cancels rather than reading the body.
 * @param {ReadableStream | null} body - From the response; why: ownership transfers to the encoded body.
 * @param {string} encoding - From negotiation; why: identity keeps the original stream.
 * @param {Headers} headers - From compressResponse; why: a body compressed whole gets its length.
 */
async function compressBody(request, body, encoding, headers) {
  if (request.method === "HEAD") {
    await body?.cancel();
    return null;
  }

  if (encoding === "identity" || body === null) return body;

  const reader = body.getReader();
  const start = await readStart(reader);
  if (start.done) {
    const whole = await compressWhole(start.parts, start.size, encoding);
    headers.set("content-length", String(whole.byteLength));
    return whole;
  }

  reader.releaseLock();
  const zip = streams[encoding]();
  for (const part of start.parts) zip.write(part);

  const source = Readable.fromWeb(body);
  source.once("error", (error) => zip.destroy(error));
  zip.once("close", () => source.destroy());
  return Readable.toWeb(source.pipe(zip));
}

/**
 * Reads what the source has ready before the event loop turns; a later chunk means a streaming page.
 * Releasing the lock fails an open read but keeps its chunk queued, and a failed source fails again for the next reader.
 * A reader that keeps the lock awaits `pending`, the read still open when the turn came.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader - From compressBody or the host; why: the read parts go out first.
 */
export async function readStart(reader) {
  const parts = [];
  let size = 0;
  let timer;
  const turn = new Promise((resolve) => {
    timer = setImmediate(resolve, null);
  });

  try {
    while (size <= shortBody) {
      const pending = reader.read();
      let part;
      try {
        part = await Promise.race([pending, turn]);
      } catch {
        return { done: false, parts };
      }

      if (part === null) return { done: false, parts, pending };
      if (part.done) return { done: true, parts, size };
      parts.push(part.value);
      size += part.value.byteLength;
    }
    return { done: false, parts };
  } finally {
    clearImmediate(timer);
  }
}

/**
 * @param {Uint8Array[]} parts - From readStart; why: the whole body.
 * @param {number} size - From readStart; why: joins the parts and sizes the Brotli window.
 * @param {"br" | "gzip"} encoding - From negotiation; why: the wire format.
 */
function compressWhole(parts, size, encoding) {
  const whole = parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
  return encoding === "br"
    ? encoders.br(whole, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: size },
      })
    : encoders.gzip(whole);
}
