import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
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

/**
 * The build stays fixed for this host's lifetime. Misses never reach the filesystem.
 * @param {string} root - From the CLI; why: retain the file set under dist/client once at start.
 */
export async function createAssets(root) {
  const publicRoot = resolve(root, "dist/client");
  const files = new Set();
  try {
    for (const entry of await readdir(publicRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isDirectory()) files.add(join(entry.parentPath, entry.name));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return (request) => asset(publicRoot, files, request);
}

/**
 * @param {string} publicRoot - From createAssets; why: confine decoded paths to the built folder.
 * @param {Set<string>} files - From startup; why: misses need no filesystem work.
 * @param {Request} request - From the host; why: resolve a built path or pass on.
 */
async function asset(publicRoot, files, request) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const path = decodeURIComponent(new URL(request.url).pathname);
  const file = resolve(publicRoot, `.${path}`);
  if (path.split("/").some((part) => part.startsWith(".") || /\.(br|gz)$/.test(part))) return null;
  if (file !== publicRoot && !file.startsWith(`${publicRoot}/`)) return null;
  const candidate = [file, join(file, "index.html")].find((entry) => files.has(entry));
  if (!candidate) return path.startsWith("/assets/") ? new Response(null, { status: 404 }) : null;
  return readStatic(files, candidate, path, request);
}

/**
 * @param {Set<string>} files - From startup; why: choose a built compressed copy without a probe.
 * @param {string} candidate - From asset; why: the known file to read.
 * @param {string} path - From the request; why: only hashed assets get a lasting cache.
 * @param {Request} request - From the host; why: honor encoding and omit HEAD bodies.
 */
async function readStatic(files, candidate, path, request) {
  const type = types[extname(candidate)] ?? "application/octet-stream";
  const headers = new Headers({
    "content-type": type,
    "cache-control": readCacheControl(path),
  });
  if (!isCompressible(type))
    return new Response(request.method === "HEAD" ? null : await readFile(candidate), { headers });
  headers.set("vary", "Accept-Encoding");
  const encoding = readEncoding(request);
  if (encoding === null) return new Response(null, { status: 406, headers });
  if (encoding !== "identity") headers.set("content-encoding", encoding);
  if (request.method === "HEAD") return new Response(null, { headers });
  const body = await readEncoded(files, candidate, encoding);
  headers.set("content-length", String(body.byteLength));
  return new Response(body, { headers });
}

/**
 * @param {Set<string>} files - From startup; why: compressed copies are optional for older builds.
 * @param {string} candidate - From asset; why: read only a known built file.
 * @param {string} encoding - From negotiation; why: build copy or on-demand compression.
 */
async function readEncoded(files, candidate, encoding) {
  if (encoding === "identity") return readFile(candidate);
  const encoded = `${candidate}.${encoding === "br" ? "br" : "gz"}`;
  if (files.has(encoded)) return readFile(encoded);
  return compressBytes(await readFile(candidate), encoding);
}

/** @param {string} path - From the URL; why: public files without build hashes can change. */
function readCacheControl(path) {
  return path.startsWith("/assets/") && /-[\w-]{4,}\.[^/]+$/.test(path)
    ? "public,max-age=31536000,immutable"
    : "public,max-age=0,must-revalidate";
}
