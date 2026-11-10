/**
 * The client files the build put inside the binary. `NODE_ENV` here is the build's `--define`, not
 * the runtime env: only the binary loads them. Dev and tests have none (Vite serves the page).
 */
const files: Record<string, string> =
  process.env.NODE_ENV === "production" ? (await import("./client-files.gen")).default : {};

/** Hashed assets never change; the page itself is read fresh. */
const immutable = { "cache-control": "public, max-age=31536000, immutable" };

/** Each client file as a static route, and the page for every other path (a deep link). */
export const pages: Record<string, Response> = {};

for (const [path, file] of Object.entries(files)) {
  pages[path] = new Response(
    Bun.file(file),
    path.startsWith("/assets/") ? { headers: immutable } : {},
  );
}

if (files["/index.html"]) pages["/*"] = new Response(Bun.file(files["/index.html"]));
