// Serve the built, prerendered pages (dist/client) the way Cloudflare's static
// assets serve them, so the shell can be checked and measured without a
// deploy: the same paths, the same Cache-Control for /_astro/* (the `_headers`
// file the adapter writes), and gzip on text, which Cloudflare's edge does and
// `astro preview` does not. The Next.js build is compressed by its own server,
// so without this the comparison would charge Astro for bytes Cloudflare
// would never send.
//
//   node scripts/serve-dist.mjs [port]      (default 4321; 0 picks a free port)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../dist/client", import.meta.url)));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json"]);

async function resolveFile(pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(
    /^(\.\.[/\\])+/,
    "",
  );
  const candidate = join(ROOT, clean);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;
  for (const file of [
    candidate,
    `${candidate}.html`,
    join(candidate, "index.html"),
  ]) {
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) return file;
  }
  return null;
}

export function startServer(port = 4321) {
  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      const file = await resolveFile(pathname);
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      const ext = extname(file);
      let body = await readFile(file);
      const headers = {
        "content-type": TYPES[ext] ?? "application/octet-stream",
        "cache-control": pathname.startsWith("/_astro/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate",
      };
      if (
        COMPRESSIBLE.has(ext) &&
        /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")
      ) {
        body = gzipSync(body, { level: 6 });
        headers["content-encoding"] = "gzip";
        headers.vary = "Accept-Encoding";
      }
      headers["content-length"] = body.length;
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" }).end("Error");
    }
  });
  return new Promise((done) =>
    server.listen(port, "127.0.0.1", () => done(server)),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startServer(Number(process.argv[2] ?? 4321));
  console.log(`serving ${ROOT} on http://127.0.0.1:${server.address().port}`);
}
