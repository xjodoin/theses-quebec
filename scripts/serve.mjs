#!/usr/bin/env node
/**
 * Tiny static file server for local preview of dist/.
 *
 *   node scripts/serve.mjs           # serves on http://localhost:5000
 *   PORT=8080 node scripts/serve.mjs
 *
 * Mirrors what GitHub Pages will do, with on-the-fly gzip so size numbers
 * match production. Use Ctrl-C to stop.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../dist");
const PORT = Number(process.env.PORT) || 5000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".gif":  "image/gif",
  ".ico":  "image/x-icon",
  ".txt":  "text/plain; charset=utf-8",
};

const GZIP_TYPES = new Set([".html", ".json", ".js", ".mjs", ".css", ".svg", ".txt"]);

function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(String(header || "").trim());
  if (!match) return null;
  let start = match[1] === "" ? null : Number(match[1]);
  let end = match[2] === "" ? null : Number(match[2]);

  if (start === null) {
    const suffix = end;
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (!Number.isInteger(start) || start < 0) return null;
    if (end === null) end = size - 1;
  }

  if (!Number.isInteger(end) || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = resolve(ROOT, "." + path);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }

  try {
    const s = await stat(file);
    if (s.isDirectory()) { res.writeHead(404).end(); return; }
    const ext = extname(file);
    const headers = {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-store",
      "accept-ranges": "bytes",
    };
    if (req.headers.range) {
      const range = parseByteRange(req.headers.range, s.size);
      if (!range) {
        res.writeHead(416, {
          ...headers,
          "content-range": `bytes */${s.size}`,
        }).end();
        return;
      }
      const body = (await readFile(file)).subarray(range.start, range.end + 1);
      res.writeHead(206, {
        ...headers,
        "content-range": `bytes ${range.start}-${range.end}/${s.size}`,
        "content-length": body.length,
      }).end(req.method === "HEAD" ? undefined : body);
      return;
    }

    let body = await readFile(file);
    if (GZIP_TYPES.has(ext) && (req.headers["accept-encoding"] || "").includes("gzip")) {
      body = gzipSync(body, { level: 6 });
      headers["content-encoding"] = "gzip";
    }
    headers["content-length"] = body.length;
    res.writeHead(200, headers).end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
  }
});

server.listen(PORT, () => {
  console.log(`▸ Serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}/`);
});
