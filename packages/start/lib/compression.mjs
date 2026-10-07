import { Readable } from "node:stream";
import { promisify } from "node:util";
import { brotliCompress, createBrotliCompress, createGzip, gzip } from "node:zlib";

const streams = { br: createBrotliCompress, gzip: createGzip };
const encoders = { br: promisify(brotliCompress), gzip: promisify(gzip) };

/**
 * Explicit q=0 wins over a wildcard; ties prefer Brotli.
 * @param {string} accepted - From the header; why: validate outside encoding weights once.
 */
function readWeights(accepted) {
  const weights = new Map();
  for (const token of accepted.split(",")) {
    const [name, ...parameters] = token.trim().toLowerCase().split(";");
    const quality = parameters.find((part) => part.trim().startsWith("q="));
    const weight = quality === undefined ? 1 : Number(quality.trim().slice(2));
    weights.set(name, Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0);
  }
  return weights;
}

/** @param {Request} request - From the host; why: pick the highest accepted weight, with Brotli winning ties. */
export function readEncoding(request) {
  const weights = readWeights(request.headers.get("accept-encoding") ?? "");
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
  return /^(text\/(javascript|css|html)|application\/javascript)(;|$)/i.test(type);
}

/**
 * @param {Uint8Array | string} bytes - From the build or a built file; why: its encoded copy.
 * @param {"br" | "gzip"} encoding - From negotiation or the build; why: the wire format.
 */
export function compressBytes(bytes, encoding) {
  return encoders[encoding](bytes);
}

/**
 * @param {Response} response - From the app; why: encoded and partial bodies must pass through.
 */
function mayCompress(response) {
  if (!isCompressible(response.headers.get("content-type") ?? "")) return false;
  if (response.headers.has("content-encoding") || response.status === 206) return false;
  return !/\bno-transform\b/i.test(response.headers.get("cache-control") ?? "");
}

/** @param {Headers} headers - From a response; why: merge the encoding cache key without repeating it. */
export function varyEncoding(headers) {
  const vary = headers.get("vary") ?? "";
  if (
    vary === "*" ||
    vary
      .toLowerCase()
      .split(/\s*,\s*/)
      .includes("accept-encoding")
  )
    return;
  headers.set("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
}

/**
 * Keep HTML streaming; the composed stream owns errors and cancellation.
 * @param {Request} request - From the host; why: encoding and HEAD semantics.
 * @param {Response} response - From the app; why: retain its body until consumed or cancelled.
 */
export async function compressResponse(request, response) {
  if (!mayCompress(response)) return response;
  const headers = new Headers(response.headers);
  varyEncoding(headers);
  const encoding = readEncoding(request);
  if (encoding === null) {
    await response.body?.cancel();
    headers.delete("content-length");
    headers.delete("etag");
    return new Response(null, { status: 406, headers });
  }
  if (request.method === "HEAD") {
    await response.body?.cancel();
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (encoding === "identity" || response.body === null)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  headers.set("content-encoding", encoding);
  headers.delete("content-length");
  headers.delete("etag");
  const body = Readable.toWeb(Readable.fromWeb(response.body).compose(streams[encoding]()));
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
