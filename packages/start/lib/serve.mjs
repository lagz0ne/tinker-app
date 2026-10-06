import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve as listen } from "@hono/node-server";
import { loadEnv } from "./env.mjs";

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

/**
 * The Node host for a built app: `.env`, then built files, then the base's server entry (ADR 0106).
 * @param {string} root - From the CLI; why: the built app to serve.
 */
export async function serve(root) {
  loadEnv(root);
  const built = await import(pathToFileURL(join(root, "dist/server/server.js")).href);
  const server = listen({
    overrideGlobalObjects: false,
    hostname: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4318),
    fetch: async (request) => (await asset(root, request)) ?? built.default.fetch(request),
  });
  console.log(
    `tinker serve: http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 4318}`,
  );
  const stopped = Promise.withResolvers();
  process.once("SIGINT", () => stopped.resolve());
  process.once("SIGTERM", () => stopped.resolve());
  await stopped.promise;
  await Promise.all([
    built.close(),
    new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
  ]);
  return 0;
}
