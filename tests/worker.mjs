import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { nodeRelayStore } from "../agent/relay-node-store.mjs";
import { makeDelivery } from "../src/delivery.js";
import { randomId, digest, utf8 } from "../src/trust.js";
import { syntheticSigner } from "./relay-fixtures.mjs";

// Exercises the built Worker contract with real SQLite and a local bucket.
// This does not emulate Sites authentication or prove Cloudflare deployment.
const { default: worker } = await import(pathToFileURL(path.resolve("dist/server/index.js")));
const parent = path.resolve(".local"), directory = path.join(parent, "relay-worker-" + randomUUID());
await mkdir(directory, { recursive: true });
const store = await nodeRelayStore(directory);
const origin = "https://inklark.example";
const assets = [];
const env = { DB: store.db, BUCKET: store.bucket, INKLARK_ORIGIN: origin,
  ASSETS: { fetch: async (request) => {
    assets.push(new URL(request.url).pathname);
    return new Response("<!doctype html><title>Synthetic Inklark asset</title>", { headers: { "Content-Type": "text/html" } });
  } },
};
try {
  const home = await worker.fetch(new Request(origin), env);
  assert.equal(home.status, 200);
  assert.equal(assets[0], "/sign.html");
  assert.match(home.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(home.headers.get("cache-control"), "no-store");
  assert.equal((await worker.fetch(new Request(origin + "/api/relay"), {})).status, 503);
  assert.equal((await worker.fetch(new Request(origin + "/api/relay"), env)).status, 401);
  const metadata = await worker.fetch(new Request(origin + "/api/relay", { headers: { "oai-authenticated-user-id": "owner" } }), env);
  assert.equal((await metadata.json()).enrollmentEnabled, false);
  const signer = await syntheticSigner(origin);
  const forbidden = await worker.fetch(new Request(origin + "/api/device", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "oai-authenticated-user-id": "owner" },
    body: JSON.stringify(signer.registration),
  }), env);
  assert.equal(forbidden.status, 503, "Compiled host must preserve fail-closed enrollment");
  assert.equal(await store.device("owner"), null);

  // The scheduled entrypoint has no visitor identity and sweeps all owners.
  const delivery = await makeDelivery({ private: "synthetic-worker-payload" }, signer.device.deliveryPublicKey, {
    version: 1, deviceId: signer.device.deviceId, requestId: randomId(), expiresAt: Date.now() + 60000,
  });
  await store.start("abandoned-owner", delivery.manifest, delivery.deliveryHash, Date.now());
  const key = `${await digest(utf8("abandoned-owner"))}/${delivery.manifest.route.requestId}/0`;
  await store.bucket.put(key, delivery.chunks[0]);
  await store.cancel("abandoned-owner", delivery.manifest.route.requestId);
  let task;
  await worker.scheduled({}, env, { waitUntil: (promise) => { task = promise; } });
  await task;
  assert.equal(await store.bucket.get(key), null);
  assert.equal((await store.request("abandoned-owner", delivery.manifest.route.requestId)).payload_deleted, 1);

  // Apply the packaged migration to a fresh SQLite database independently.
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(await readFile("drizzle/0000_relay.sql", "utf8"));
    assert.ok(db.prepare("PRAGMA table_info(requests)").all().some((column) => column.name === "last_cleaned_at"));
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().some((index) => index.name === "approval_once"));
  } finally { db.close(); }
  console.log("Built Worker checks passed: static routing/CSP, identity required, enrollment disabled, global cleanup, and fresh schema migration. Live gateway and scheduled delivery remain unverified.");
} finally {
  store.close();
  if (path.dirname(directory) !== parent || !path.basename(directory).startsWith("relay-worker-")) throw Error("Unsafe test cleanup path.");
  await rm(directory, { recursive: true, force: true });
}
