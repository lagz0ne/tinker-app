import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import app, { close } from "../dist/server/server.js";

const publicRoot = resolve("dist/client");
const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

async function fetchRequest(request) {
  const path = new URL(request.url).pathname;
  const folder = path.split("/").at(1);
  if (folder === "assets" || folder === "r") {
    const file = resolve(publicRoot, `.${decodeURIComponent(path)}`);
    if (!file.startsWith(`${publicRoot}/${folder}/`)) return new Response(null, { status: 404 });
    try {
      return new Response(await readFile(file), {
        headers: {
          "content-type": types[extname(file)] ?? "application/octet-stream",
          "cache-control": folder === "assets" ? "public,max-age=31536000,immutable" : "no-cache",
        },
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return new Response(null, { status: 404 });
    }
  }
  return app.fetch(request);
}

async function main() {
  const server = serve({
    overrideGlobalObjects: false,
    hostname: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4318),
    fetch: fetchRequest,
  });
  const stopped = Promise.withResolvers();
  const stop = () => stopped.resolve();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await stopped.promise;
  const httpClosed = new Promise((done, reject) => {
    server.close((error) => (error ? reject(error) : done()));
  });
  await Promise.all([close(), httpClosed]);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

if (import.meta.main) await main();
