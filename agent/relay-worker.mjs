import { createRelay, sweepRelay } from "./relay.mjs";
import { RelayStore } from "./relay-store.mjs";

// This entrypoint is for Sites' authenticated gateway. Deploying it behind a
// different gateway requires replacing its trusted identity adapter explicitly.
export default {
  // Supported by Cloudflare cron deployments. Sites scheduling still needs
  // independent live verification; a fetch handler alone does not schedule it.
  async scheduled(_controller, env, context) {
    if (!env.DB || !env.BUCKET) throw Error("Relay cleanup storage is unavailable.");
    context.waitUntil(sweepRelay(new RelayStore(env.DB, env.BUCKET)));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/api/")) {
      if (!env.DB || !env.BUCKET || !env.INKLARK_ORIGIN)
        return new Response('{"error":"The relay is not configured."}', {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      // Sites validates authentication and injects this Site-scoped ID. The
      // application never accepts an owner supplied in JSON or query parameters.
      const owner = request.headers.get("oai-authenticated-user-id");
      return createRelay({
        store: new RelayStore(env.DB, env.BUCKET),
        origin: env.INKLARK_ORIGIN,
      })(request, owner);
    }
    if (!env.ASSETS)
      return new Response("Static assets are unavailable.", { status: 503 });
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405 });
    if (url.pathname === "/") url.pathname = "/sign.html";
    const response = await env.ASSETS.fetch(new Request(url, request));
    const headers = new Headers(response.headers);
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
    );
    headers.set("X-Content-Type-Options", "nosniff");
    if (url.pathname.endsWith(".html"))
      headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  },
};
