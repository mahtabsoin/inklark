import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { nodeRelayStore } from "../agent/relay-node-store.mjs";
import { createRelay, sweepRelay } from "../agent/relay.mjs";
import { randomId, fingerprint, digest, utf8 } from "../src/trust.js";
import { makeDelivery, openDelivery, verifyChunk, verifyDeliveryTarget, deliveryFingerprint } from "../src/delivery.js";
import { deliverRemoteRequest } from "../agent/remote-adapter.mjs";
import { syntheticSigner } from "./relay-fixtures.mjs";

const origin = "https://inklark.example";
test("durable relay isolates owners, authenticates enrollment and completion, and handles encrypted upload retries", async () => {
  const parent = path.resolve(".local"),
    directory = path.join(parent, "relay-test-" + randomUUID());
  await mkdir(directory, { recursive: true });
  let store = await nodeRelayStore(directory),
    relay = createRelay({ store, origin, enrollmentAllowed: true });
  async function api(endpoint, body, owner = "owner-a", headers = {}) {
    return relay(
      new Request(origin + endpoint, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          ...(body === undefined ? {} : { Origin: origin }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      owner,
    );
  }
  async function rpc(name, args = {}, owner = "owner-a") {
    const response = await api(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      owner,
    );
    const result = (await response.json()).result;
    if (result.isError) throw Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  }
  try {
    assert.equal((await api("/api/relay", undefined, null)).status, 401);
    assert.equal(
      (
        await api("/api/device", {}, "owner-a", {
          Origin: "https://attacker.example",
        })
      ).status,
      403,
    );
    const signer = await syntheticSigner(origin);
    assert.equal((await api("/api/device", signer.registration)).status, 201);
    assert.equal(
      (await api("/api/device", signer.registration)).status,
      200,
      "Identical enrollment retry must be idempotent",
    );
    const replacement = await syntheticSigner(origin);
    assert.equal(
      (await api("/api/device", replacement.registration)).status,
      400,
      "A new device cannot replace a pinned device",
    );
    const tampered = structuredClone(signer.registration);
    tampered.device.name = "Another Person";
    assert.equal((await api("/api/device", tampered, "owner-b")).status, 400);
    await assert.rejects(
      () => rpc("get_signing_device", {}, "owner-b"),
      /pairing/,
    );
    const target = await rpc("get_signing_device");
    assert.equal(target.deviceId, signer.device.deviceId);
    assert.equal(JSON.stringify(target).includes("credential"), false);
    const payload = {
      document: "synthetic-private-pdf",
      answer: "private-answer-for-regression",
      padding: "A".repeat(450000),
    };
    const route = {
      version: 1,
      deviceId: target.deviceId,
      requestId: randomId(),
      expiresAt: Date.now() + 60000,
    };
    const delivery = await makeDelivery(
      payload,
      target.deliveryPublicKey,
      route,
    );
    assert.ok(delivery.chunks.length > 1);
    await rpc("start_signing_request", { manifest: delivery.manifest });
    await rpc("start_signing_request", { manifest: delivery.manifest });
    await assert.rejects(
      () => rpc("finish_signing_request", { request_id: route.requestId }),
      /incomplete/,
    );
    const changed = structuredClone(delivery.manifest);
    changed.iv = randomId();
    await assert.rejects(() =>
      rpc("start_signing_request", { manifest: changed }),
    );
    await assert.rejects(
      () =>
        rpc("upload_signing_chunk", {
          request_id: route.requestId,
          index: 0,
          ciphertext: "invalid",
        }),
      /manifest/,
    );
    for (const [index, ciphertext] of delivery.chunks.entries()) {
      await rpc("upload_signing_chunk", {
        request_id: route.requestId,
        index,
        ciphertext,
      });
      await rpc("upload_signing_chunk", {
        request_id: route.requestId,
        index,
        ciphertext,
      });
    }
    const pending = await rpc("finish_signing_request", {
      request_id: route.requestId,
    });
    assert.equal(pending.status, "pending");
    assert.ok(pending.openUrl.includes(route.requestId));
    await assert.rejects(
      () =>
        rpc("get_request_status", { request_id: route.requestId }, "owner-b"),
      /unavailable/,
    );
    const inbox = await (
      await api("/api/inbox?device=" + target.deviceId)
    ).json();
    assert.equal(inbox.requests.length, 1);
    assert.equal(inbox.requests[0].deliveryHash, delivery.deliveryHash);
    assert.equal(JSON.stringify(inbox).includes(payload.answer), false);
    const received = [];
    for (let i = 0; i < delivery.chunks.length; i++)
      received.push(
        await (await api(`/api/chunks/${route.requestId}/${i}`)).text(),
      );
    assert.deepEqual(
      await openDelivery(
        delivery.manifest,
        received,
        signer.delivery.privateKey,
        target.deviceId,
      ),
      payload,
    );
    await assert.rejects(() =>
      verifyChunk(delivery.manifest, 0, received[0].slice(0, -1) + "B"),
    );
    // Reopen the actual SQLite database and encrypted bucket to prove durability.
    store.close();
    store = await nodeRelayStore(directory);
    relay = createRelay({ store, origin });
    assert.equal(
      (await rpc("get_request_status", { request_id: route.requestId })).status,
      "pending",
    );
    const intent = {
      version: 1,
      requestId: route.requestId,
      deviceId: target.deviceId,
      credentialId: signer.device.credential.id,
      signerName: signer.device.name,
      appearanceRevision: signer.device.appearanceRevision,
      documentHash: await digest(utf8(payload.document)),
      outputHash: randomId(),
      editsHash: randomId(),
      deliveryHash: delivery.deliveryHash,
      nonce: randomId(),
      expiresAt: route.expiresAt,
    };
    const record = await signer.approve(intent);
    const forged = structuredClone(record);
    forged.intent.outputHash = randomId();
    assert.equal((await api("/api/complete", forged)).status, 400);
    await assert.rejects(
      () => rpc("approve_request", { request_id: route.requestId }),
      /Unknown tool/,
    );
    const complete = await api("/api/complete", record);
    assert.equal(
      complete.status,
      200,
      JSON.stringify(await complete.clone().json()),
    );
    assert.equal((await complete.json()).status, "completed");
    assert.equal(
      (await api("/api/complete", record)).status,
      200,
      "Completion retry reports the existing result without signing again",
    );
    const status = await rpc("get_request_status", {
      request_id: route.requestId,
    });
    assert.equal(status.receipt.outputHash, intent.outputHash);
    assert.equal(JSON.stringify(status).includes("assertion"), false);
    assert.equal(JSON.stringify(status).includes("documentHash"), false);
    assert.equal((await api(`/api/chunks/${route.requestId}/0`)).status, 400);
    const next = await makeDelivery(
      { document: "second document" },
      target.deliveryPublicKey,
      { ...route, requestId: randomId() },
    );
    await rpc("start_signing_request", { manifest: next.manifest });
    for (const [index, ciphertext] of next.chunks.entries())
      await rpc("upload_signing_chunk", {
        request_id: next.manifest.route.requestId,
        index,
        ciphertext,
      });
    await rpc("finish_signing_request", {
      request_id: next.manifest.route.requestId,
    });
    const replay = structuredClone(record);
    replay.intent.requestId = next.manifest.route.requestId;
    replay.intent.deliveryHash = next.deliveryHash;
    assert.equal(
      (await api("/api/complete", replay)).status,
      400,
      "An old assertion cannot authorize a new request",
    );
    const expired = createRelay({
      store,
      origin,
      now: () => Date.now() + 120000,
    });
    const expiredStatus = await expired(
      new Request(origin + "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_request_status",
            arguments: { request_id: next.manifest.route.requestId },
          },
        }),
      }),
      "owner-a",
    );
    assert.equal(
      JSON.parse((await expiredStatus.json()).result.content[0].text).status,
      "expired",
    );
  } finally {
    store.close();
    if (
      path.dirname(directory) !== parent ||
      !path.basename(directory).startsWith("relay-test-")
    )
      throw Error("Unsafe test cleanup path.");
    await rm(directory, { recursive: true, force: true });
  }
});

async function withRelay(fn) {
  const parent = path.resolve(".local"), directory = path.join(parent, "relay-test-" + randomUUID());
  const store = await nodeRelayStore(directory);
  let clock = Date.now();
  const relay = createRelay({ store, origin, now: () => clock, enrollmentAllowed: true });
  const api = async (endpoint, body) => relay(new Request(origin + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), "owner");
  const invoke = async (name, args = {}) => {
    const response = await api("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const result = (await response.json()).result;
    if (result.isError) throw Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  try {
    const signer = await syntheticSigner(origin);
    assert.equal((await api("/api/device", signer.registration)).status, 201);
    const target = await invoke("get_signing_device");
    const delivery = await makeDelivery({ privateAnswer: "synthetic-private-marker" }, target.deliveryPublicKey, {
      version: 1, deviceId: target.deviceId, requestId: randomId(), expiresAt: clock + 60000,
    });
    await fn({ store, api, invoke, relay, signer, target, delivery, advance: (ms) => clock += ms, now: () => clock });
  } finally {
    store.close();
    if (path.dirname(directory) !== parent || !path.basename(directory).startsWith("relay-test-")) throw Error("Unsafe test cleanup path.");
    await rm(directory, { recursive: true, force: true });
  }
}

test("adapter resumes a lost finish response without reopening uploads", () => withRelay(async ({ invoke, delivery, store }) => {
  let dropped = false;
  const unreliable = async (name, args) => {
    const result = await invoke(name, args);
    if (name === "finish_signing_request" && !dropped) {
      dropped = true;
      throw Error("Synthetic lost response after server commit");
    }
    return result;
  };
  await assert.rejects(() => deliverRemoteRequest(delivery, unreliable), /lost response/);
  const called = [];
  const resumed = await deliverRemoteRequest(delivery, async (name, args) => {
    called.push(name);
    return invoke(name, args);
  });
  assert.equal(resumed.status, "pending");
  assert.deepEqual(called, ["start_signing_request", "finish_signing_request"]);
  const row = await store.request("owner", resumed.requestId);
  assert.equal(JSON.stringify(row).includes("synthetic-private-marker"), false);
}));

for (const closeBy of ["expiry", "cancel"]) {
  test(`late upload after ${closeBy} cleanup cannot leave ciphertext behind`, () => withRelay(async ({ store, api, invoke, delivery, advance, now }) => {
    await invoke("start_signing_request", { manifest: delivery.manifest });
    const originalPut = store.bucket.put;
    let release, entered;
    const paused = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    let storageKey;
    store.bucket.put = async (key, value) => {
      storageKey = key;
      entered();
      await paused;
      return originalPut(key, value);
    };
    const upload = invoke("upload_signing_chunk", { request_id: delivery.manifest.route.requestId, index: 0, ciphertext: delivery.chunks[0] });
    await started;
    if (closeBy === "expiry") {
      advance(120000);
      await sweepRelay(store, { now: now() });
    } else {
      const response = await api("/api/cancel", { requestId: delivery.manifest.route.requestId });
      assert.equal((await response.json()).status, "cancelled");
    }
    release();
    await assert.rejects(() => upload, /closed during upload/);
    assert.equal(await store.bucket.get(storageKey), null);
    assert.equal(await store.chunkCount("owner", delivery.manifest.route.requestId), 0);
    // Simulate interruption between a bucket write and compensating deletion.
    await originalPut(storageKey, delivery.chunks[0]);
    advance(6 * 60000);
    await sweepRelay(store, { now: now() });
    assert.equal(await store.bucket.get(storageKey), null, "Global sweeps revisit deleted payloads without owner activity");
  }));
}

test("first enrollment fails closed without a trusted host admission boundary", () => withRelay(async ({ store }) => {
  const unverifiedHost = createRelay({ store, origin });
  const softwareSigner = await syntheticSigner(origin);
  const response = await unverifiedHost(new Request(origin + "/api/device", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(softwareSigner.registration),
  }), "fresh-owner");
  assert.equal(response.status, 503, "A spoofable Origin and software-generated UV assertion must not establish human enrollment");
  assert.equal(await store.device("fresh-owner"), null);
}));

test("human pairing pin rejects a relay-substituted destination", () => withRelay(async ({ target }) => {
  const pin = await deliveryFingerprint(target);
  await verifyDeliveryTarget(target, pin);
  await assert.rejects(() => verifyDeliveryTarget(target), /pairing fingerprint/);
  const replacement = await syntheticSigner(origin);
  await assert.rejects(() => verifyDeliveryTarget({ ...target, deliveryPublicKey: replacement.device.deliveryPublicKey, fingerprint: pin }, pin), /pairing fingerprint/);
}));
