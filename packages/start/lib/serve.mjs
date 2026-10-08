import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { compressBytes, isCompressible, readEncoding } from "./compression.mjs";

const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

const dotPath = /(?:^|\/)\./;
const slashes = /\/{2,}/g;
const hashedAsset = /-[\w-]{4,}\.[^/]+$/;
const cacheLimit = 64 * 1024 * 1024;

/**
 * The build stays fixed for this host's lifetime. Retain at most 64 MiB of bytes after first use.
 * @param {string} root - From the CLI; why: retain the file set under dist/client once at start.
 */
export async function createAssets(root) {
  const publicRoot = resolve(root, "dist/client");
  const files = new Set();
  const paths = new Map();
  try {
    for (const entry of await readdir(publicRoot, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      const file = join(entry.parentPath, entry.name);
      files.add(file);
      const path = `/${relative(publicRoot, file)}`;
      if (dotPath.test(path)) continue;
      const type = types[extname(file)] ?? "application/octet-stream";
      paths.set(path, { file, type, compressible: isCompressible(type) });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  addPages(paths);
  const cache = { bytes: new Map(), size: 0 };
  return (request) => asset(paths, files, cache, request);
}

/** @param {Map} paths - From startup; why: prerendered pages have directory URLs too. */
function addPages(paths) {
  for (const [path, file] of paths) {
    if (!path.endsWith("/index.html")) continue;
    const parent = path.slice(0, -11);
    if (parent && !paths.has(parent)) paths.set(parent, file);
    if (!paths.has(`${parent}/`)) paths.set(`${parent}/`, file);
  }
}

/**
 * @param {Map} paths - From startup; why: decoded URLs select a known file without path work.
 * @param {Set<string>} files - From startup; why: compressed copies need no filesystem probe.
 * @param {{ bytes: Map, size: number }} cache - Host-owned; why: retain a bounded set of built bytes.
 * @param {Request} request - From the host; why: resolve a built path or pass on.
 */
function asset(paths, files, cache, request) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const path = decodeURIComponent(new URL(request.url).pathname).replace(slashes, "/");
  const file = paths.get(path);
  if (!file)
    return path.startsWith("/assets/") && !dotPath.test(path)
      ? new Response(null, { status: 404 })
      : null;
  return readStatic(files, cache, file, path, request);
}

/**
 * @param {Set<string>} files - From startup; why: optional encoded copies are known.
 * @param {{ bytes: Map, size: number }} cache - Host-owned; why: read and retain a format once.
 * @param {{ file: string, type: string, compressible: boolean }} file - From the URL table; why: file metadata stays fixed.
 * @param {string} path - From the request; why: hashed URLs get a lasting cache.
 * @param {Request} request - From the host; why: encoding and HEAD semantics.
 */
function readStatic(files, cache, file, path, request) {
  const headers = new Headers({
    "content-type": file.type,
    "cache-control": readCacheControl(path),
  });
  const encoding = file.compressible ? readEncoding(request) : "identity";
  if (file.compressible) headers.set("vary", "Accept-Encoding");
  if (encoding === null) return new Response(null, { status: 406, headers });
  if (encoding !== "identity") headers.set("content-encoding", encoding);
  if (request.method === "HEAD") return new Response(null, { headers });
  const bytes = readEncoded(files, cache, file.file, encoding);
  return bytes instanceof Promise
    ? bytes.then((body) => staticResponse(body, headers, file.compressible))
    : staticResponse(bytes, headers, file.compressible);
}

/**
 * @param {Uint8Array} body - Borrowed from the host cache; why: Response copies these bytes.
 * @param {Headers} headers - Request-owned; why: each response has its own headers.
 * @param {boolean} compressible - From startup; why: preserve content-length on encoded file responses.
 */
function staticResponse(body, headers, compressible) {
  if (compressible) headers.set("content-length", String(body.byteLength));
  return new Response(body, { headers });
}

/**
 * @param {Set<string>} files - From startup; why: prefer the build's compressed copy.
 * @param {{ bytes: Map, size: number }} cache - Host-owned; why: share each read and its result.
 * @param {string} candidate - From the URL table; why: read only a known built file.
 * @param {string} encoding - From negotiation; why: build copy or on-demand compression.
 */
function readEncoded(files, cache, candidate, encoding) {
  const encoded =
    encoding === "identity" ? candidate : `${candidate}.${encoding === "br" ? "br" : "gz"}`;
  const kept = cache.bytes.get(encoded);
  if (kept !== undefined) return kept;
  const pending = loadBytes(files, cache, candidate, encoded, encoding);
  cache.bytes.set(encoded, pending);
  return pending;
}

/**
 * @param {Set<string>} files - From startup; why: avoid probing for optional compressed copies.
 * @param {{ bytes: Map, size: number }} cache - Host-owned; why: failed or oversized reads are not retained.
 * @param {string} candidate - The original file; why: older builds may have no compressed copy.
 * @param {string} encoded - The cache key; why: each format has its own kept bytes.
 * @param {string} encoding - From negotiation; why: select the fallback encoder.
 */
async function loadBytes(files, cache, candidate, encoded, encoding) {
  try {
    const body =
      encoding === "identity" || files.has(encoded)
        ? await readFile(encoded)
        : await compressBytes(await readEncoded(files, cache, candidate, "identity"), encoding);
    if (cache.size + body.byteLength <= cacheLimit) {
      cache.size += body.byteLength;
      cache.bytes.set(encoded, body);
    } else cache.bytes.delete(encoded);
    return body;
  } catch (error) {
    cache.bytes.delete(encoded);
    throw error;
  }
}

/** @param {string} path - From the URL; why: public files without build hashes can change. */
function readCacheControl(path) {
  return path.startsWith("/assets/") && hashedAsset.test(path)
    ? "public,max-age=31536000,immutable"
    : "public,max-age=0,must-revalidate";
}
