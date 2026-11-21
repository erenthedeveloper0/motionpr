import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

export interface StaticServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Minimal static file server for tests (directory traversal safe). `?delay=<ms>` on any request
 * holds the response that long (a slow image).
 */
export async function serveDirectory(root: string): Promise<StaticServer> {
  const base = resolve(root);
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const delay = Number(url.searchParams.get("delay") ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, 10_000)));
    const pathname = decodeURIComponent(url.pathname);
    let file = normalize(join(base, pathname));
    if (!file.startsWith(base)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      await stat(file);
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
