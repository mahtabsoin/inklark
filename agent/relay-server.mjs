import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { nodeRelayStore } from "./relay-node-store.mjs";
import { createRelay, sweepRelay } from "./relay.mjs";

// Local development adapter only. Hosted identity is supplied by the trusted
// gateway, never by an arbitrary user-supplied HTTP identity header.
export async function startRelayServer({
  directory = ".local/relay-development",
  port = 4320,
  owner = "local-development",
} = {}) {
  const store = await nodeRelayStore(directory);
  let relay, origin;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
    );
    try {
      if (req.headers.host !== new URL(origin).host) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url, origin);
      if (url.pathname === "/mcp" || url.pathname.startsWith("/api/")) {
        const options = {
          method: req.method,
          headers: req.headers,
          ...(!["GET", "HEAD"].includes(req.method)
            ? { body: Readable.toWeb(req), duplex: "half" }
            : {}),
        };
        const response = await relay(new Request(url, options), owner);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      const root = path.resolve("dist"),
        file = path.resolve(
          root,
          "." +
            decodeURIComponent(
              url.pathname === "/" ? "/sign.html" : url.pathname,
            ),
        );
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const data = await readFile(file);
      const type =
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".mjs": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".json": "application/json",
          ".webmanifest": "application/manifest+json",
          ".ttf": "font/ttf",
          ".wasm": "application/wasm",
        }[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type });
      res.end(data);
    } catch {
      res.writeHead(404).end("Unavailable");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://localhost:${server.address().port}`;
  // Explicit loopback-only test admission. This is not a hosted auth adapter.
  relay = createRelay({ store, origin, enrollmentAllowed: true });
  const cleanupTimer = setInterval(() => sweepRelay(store).catch(() => {}), 60000);
  cleanupTimer.unref();
  return {
    origin,
    store,
    close: async () => {
      clearInterval(cleanupTimer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await startRelayServer();
  console.log(`Inklark development relay: ${app.origin}`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => app.close().then(() => process.exit(0)));
}
