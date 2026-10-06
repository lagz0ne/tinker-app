import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

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
 * @param {string} file - From asset; why: a path, or the index.html under it.
 * @param {boolean} immutable - From asset; why: hashed build assets never change.
 */
async function readStatic(file, immutable) {
  for (const candidate of [file, join(file, "index.html")]) {
    try {
      return new Response(await readFile(candidate), {
        headers: {
          "content-type": types[extname(candidate)] ?? "application/octet-stream",
          "cache-control": immutable
            ? "public,max-age=31536000,immutable"
            : "public,max-age=0,must-revalidate",
        },
      });
    } catch (error) {
      if (!["ENOENT", "EISDIR", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  return null;
}

/**
 * Answer a built file: hashed assets, public/ files, and prerendered pages.
 * Dot paths stay private; null passes the request on to the server entry.
 * @param {string} root - From the CLI; why: static files live under its dist/client.
 * @param {Request} request - From the Node host; why: answer a file or pass it on.
 */
export async function asset(root, request) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const publicRoot = resolve(root, "dist/client");
  const path = decodeURIComponent(new URL(request.url).pathname);
  const file = resolve(publicRoot, `.${path}`);
  if (path.split("/").some((part) => part.startsWith("."))) return null;
  if (file !== publicRoot && !file.startsWith(`${publicRoot}/`)) return null;
  const immutable = path.startsWith("/assets/");
  const found = await readStatic(file, immutable);
  if (found || !immutable) return found;
  return new Response(null, { status: 404 });
}
