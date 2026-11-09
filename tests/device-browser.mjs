import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {
  verifyApprovalRecord,
  verifyDeviceRegistration,
  verifySavedApprovalRecord,
} from "../src/device.js";
import { randomId, sealRequest, digest, utf8 } from "../src/trust.js";

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/")
    return response
      .writeHead(200, { "Content-Type": "text/html" })
      .end(
        '<!doctype html><title>Synthetic Inklark authentication test</title><script type="module">import * as device from "/src/device.js"; window.device = device;</script>',
      );
  if (
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/pdf-assets/") ||
    ["/sign.html", "/icon.svg"].includes(pathname)
  ) {
    const file = path.resolve(
      "dist",
      "." + new URL(request.url, "http://localhost").pathname,
    );
    if (!file.startsWith(path.resolve("dist") + path.sep))
      return response.writeHead(403).end();
    const type =
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".ttf": "font/ttf",
        ".wasm": "application/wasm",
      }[path.extname(file)] || "application/octet-stream";
    try {
      return response
        .writeHead(200, { "Content-Type": type })
        .end(await readFile(file));
    } catch {
      return response.writeHead(404).end();
    }
  }
  if (!["/src/device.js", "/src/trust.js"].includes(pathname))
    return response.writeHead(404).end();
  response
    .writeHead(200, { "Content-Type": "text/javascript" })
    .end(await readFile("." + pathname));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(() => !!window.device);
  const legacyNonce = randomId();
  await page.evaluate(async (nonce) => new Promise((resolve, reject) => {
    const open = indexedDB.open("inklark-device-v1", 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("device");
      open.result.createObjectStore("approvals", { keyPath: "nonce" });
    };
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction("approvals", "readwrite");
      tx.objectStore("approvals").add({ nonce, expiresAt: 1, record: { intent: { requestId: nonce }, syntheticLegacyFixture: true } });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(Error("Legacy fixture failed")); };
    };
  }), legacyNonce);
  assert.equal(await page.evaluate(async (nonce) => (await device.getApprovalRecord(nonce)).record.syntheticLegacyFixture, legacyNonce), true, "Schema upgrade preserves earlier approval records");
  const profile = await page.evaluate(async () => {
    const p = await device.enrollDevice("Jane Example");
    return device.publicDevice(p);
  });
  assert.equal(profile.name, "Jane Example");
  const registration = await page.evaluate(async () =>
    device.deviceRegistration(await device.getDevice()),
  );
  assert.equal(
    (await verifyDeviceRegistration(registration, origin)).deviceId,
    profile.deviceId,
  );
  for (const change of [
    { name: "Another Person" },
    { appearanceRevision: randomId() },
    { deliveryPublicKey: { ...profile.deliveryPublicKey, x: randomId() } },
    { credential: { ...registration.device.credential, id: randomId() } },
  ])
    await assert.rejects(
      () =>
        verifyDeviceRegistration(
          { ...registration, device: { ...registration.device, ...change } },
          origin,
        ),
      /enrollment/,
    );
  assert.equal(JSON.stringify(profile).includes("privateKey"), false);
  await assert.rejects(
    () => page.evaluate(() => device.enrollDevice("Another Person")),
    /already/,
  );
  await page.reload();
  await page.waitForFunction(() => !!window.device);
  assert.equal(
    await page.evaluate(async () => (await device.getDevice()).deviceId),
    profile.deviceId,
  );
  assert.equal(
    await page.evaluate(
      async () => (await device.getDevice()).deliveryPrivateKey.extractable,
    ),
    false,
  );
  const route = {
    version: 1,
    deviceId: profile.deviceId,
    requestId: randomId(),
    expiresAt: Date.now() + 60000,
  };
  const envelope = await sealRequest(
    { document: "synthetic-document", answer: "Jane Example" },
    profile.deliveryPublicKey,
    route,
  );
  const decrypted = await page.evaluate(async (envelope) => {
    const { openRequest } = await import("/src/trust.js");
    const p = await device.getDevice();
    return openRequest(envelope, p.deliveryPrivateKey, p.deviceId);
  }, envelope);
  assert.equal(decrypted.answer, "Jane Example");
  const hashes = {
    requestId: route.requestId,
    documentHash: randomId(),
    outputHash: randomId(),
    editsHash: randomId(),
    expiresAt: route.expiresAt,
  };
  const intent = await page.evaluate(
    async (hashes) =>
      device.makeApprovalIntent(hashes, await device.getDevice()),
    hashes,
  );
  const proof = await page.evaluate(
    (intent) => device.approveIntent(intent),
    intent,
  );
  await verifyApprovalRecord(proof, profile.credential, intent, origin);
  await assert.rejects(
    () => page.evaluate((intent) => device.approveIntent(intent), intent),
    /already approved/,
  );
  for (const change of [
    { outputHash: randomId() },
    { documentHash: randomId() },
    { editsHash: randomId() },
    { signerName: "Another Person" },
    { deviceId: randomId() },
  ])
    await assert.rejects(
      () =>
        verifyApprovalRecord(
          proof,
          profile.credential,
          { ...intent, ...change },
          origin,
        ),
      /pinned request/,
    );
  const secondIntent = await page.evaluate(
    async (hashes) =>
      device.makeApprovalIntent(hashes, await device.getDevice()),
    { ...hashes, requestId: randomId() },
  );
  const canceled = await page.evaluate(async (intent) => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async () => {
      throw new DOMException("Synthetic cancellation", "NotAllowedError");
    };
    try {
      await device.approveIntent(intent);
      return false;
    } catch {
      return true;
    } finally {
      navigator.credentials.get = get;
    }
  }, secondIntent);
  assert.ok(canceled);
  const secondProof = await page.evaluate(
    (intent) => device.approveIntent(intent),
    secondIntent,
  );
  await verifyApprovalRecord(
    secondProof,
    profile.credential,
    secondIntent,
    origin,
  );
  const storedProof = await page.evaluate(
    async (nonce) => (await device.getApprovalRecord(nonce)).record,
    secondIntent.nonce,
  );
  assert.deepEqual(storedProof, secondProof);
  await assert.rejects(
    () => page.evaluate((intent) => device.approveIntent(intent), { ...secondIntent, nonce: randomId() }),
    /already approved/,
    "A new nonce must not authorize the same request twice",
  );
  const updatedProfile = await page.evaluate(async () =>
    device.publicDevice(await device.getDevice()),
  );
  assert.equal(
    (
      await verifySavedApprovalRecord(
        storedProof,
        updatedProfile.credential,
        secondIntent,
        origin,
      )
    ).freshAuthorization,
    false,
  );
  const interruptedIntent = await page.evaluate(
    async (hashes) =>
      device.makeApprovalIntent(hashes, await device.getDevice()),
    { ...hashes, requestId: randomId(), outputHash: await digest(utf8("Synthetic interrupted output")) },
  );
  const interrupted = await page.evaluate(async (intent) => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const r = original.apply(this, args);
      if (
        this.name === "device" &&
        this.transaction.objectStoreNames.contains("approvals")
      )
        this.transaction.abort();
      return r;
    };
    try {
      await device.approveIntent(intent, { bytes: new TextEncoder().encode("Synthetic interrupted output"), name: "Synthetic.pdf", pages: 1, signatureCount: 1 });
      return false;
    } catch {
      return true;
    } finally {
      IDBObjectStore.prototype.put = original;
    }
  }, interruptedIntent);
  assert.ok(interrupted);
  assert.equal(
    await page.evaluate(
      async (nonce) => !!(await device.getApprovalRecord(nonce)),
      interruptedIntent.nonce,
    ),
    false,
    "Storage failure must not consume the approval",
  );
  await page.evaluate(
    (intent) => device.approveIntent(intent, { bytes: new TextEncoder().encode("Synthetic interrupted output"), name: "Synthetic.pdf", pages: 1, signatureCount: 1 }),
    interruptedIntent,
  );
  const racing = await page.evaluate(
    async (hashes) => {
      const p = await device.getDevice();
      const a = await device.makeApprovalIntent(hashes, p),
        b = await device.makeApprovalIntent({ ...hashes, requestId: (await import("/src/trust.js")).randomId() }, p);
      const original = navigator.credentials.get.bind(navigator.credentials);
      let queue = Promise.resolve(),
        number = 0,
        release;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      navigator.credentials.get = async (options) => {
        const n = ++number;
        const operation = queue.then(() => original(options));
        queue = operation.catch(() => {});
        const response = await operation;
        if (n === 1) await wait;
        return response;
      };
      try {
        const first = device.approveIntent(a),
          second = device.approveIntent(b).then(
            (r) => {
              release();
              return r;
            },
            (e) => {
              release();
              throw e;
            },
          );
        const records = await Promise.all([first, second]);
        const { unbase64url } = await import("/src/trust.js");
        const counters = records.map((r) => {
          const bytes = unbase64url(r.assertion.response.authenticatorData);
          return new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(
            0,
          );
        });
        return {
          counter: (await device.getDevice()).credential.counter,
          counters,
        };
      } finally {
        navigator.credentials.get = original;
      }
    },
    { ...hashes, requestId: randomId() },
  );
  assert.equal(
    racing.counter,
    Math.max(...racing.counters),
    "Concurrent approvals must preserve the newest signature counter",
  );
  const mutable = await page.evaluate(
    async (hashes) =>
      device.makeApprovalIntent(hashes, await device.getDevice()),
    { ...hashes, requestId: randomId() },
  );
  const changed = await page.evaluate(async (intent) => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async (options) => {
      const response = await get(options);
      intent.outputHash = intent.documentHash;
      return response;
    };
    try {
      await device.approveIntent(intent);
      return false;
    } catch (error) {
      return /changed/.test(error.message);
    } finally {
      navigator.credentials.get = get;
    }
  }, mutable);
  assert.ok(changed, "Changing the document during authentication must fail");
  assert.deepEqual(errors, []);
  const ui = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    acceptDownloads: true,
  });
  const uiPage = await ui.newPage();
  uiPage.on("pageerror", (e) => errors.push(e.message));
  const uiCdp = await ui.newCDPSession(uiPage);
  await uiCdp.send("WebAuthn.enable");
  const { authenticatorId: uiAuthenticatorId } = await uiCdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await uiPage.goto(origin + "/sign.html");
  await uiPage.getByLabel("Your name for signing").fill("Jane Example");
  await uiPage
    .getByRole("button", { name: "Set up device signing", exact: true })
    .click();
  await uiPage.getByRole("button", { name: "Try a prepared sample" }).click();
  await uiPage
    .getByRole("button", { name: "Sign this document", exact: true })
    .waitFor();
  assert.equal(
    await uiPage.locator('input[type="checkbox"]').count(),
    0,
    "A complete request must have no mandatory approval checkbox",
  );
  assert.ok(
    await uiPage.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await mkdir("test-results", { recursive: true });
  await uiPage.screenshot({
    path: "test-results/device-ready-mobile.png",
    fullPage: true,
  });
  await uiPage
    .getByRole("button", { name: "View document", exact: true })
    .click();
  await uiPage.locator("#preview-pages canvas").waitFor();
  await uiPage.getByRole("button", { name: "Close", exact: true }).click();
  const download = uiPage.waitForEvent("download");
  await uiPage
    .getByRole("button", { name: "Sign this document", exact: true })
    .click();
  await (await download).saveAs("test-results/device-approved.pdf");
  await uiPage
    .getByRole("heading", { name: "Your PDF is signed.", exact: true })
    .waitFor();
  const proofDownload = uiPage.waitForEvent("download");
  await uiPage
    .getByRole("button", { name: "Save approval record", exact: true })
    .click();
  const saved = await proofDownload;
  const finalProof = JSON.parse(await readFile(await saved.path(), "utf8"));
  assert.equal(finalProof.format, "inklark-approval");
  assert.equal(finalProof.intent.signerName, "Jane Example");
  assert.equal(
    await digest(await readFile("test-results/device-approved.pdf")),
    finalProof.intent.outputHash,
  );
  const countBeforeReload = (await uiCdp.send("WebAuthn.getCredentials", { authenticatorId: uiAuthenticatorId })).credentials[0].signCount;
  await uiPage.reload();
  await uiPage.getByRole("heading", { name: "Your PDF is signed.", exact: true }).waitFor();
  const recoveredDownload = uiPage.waitForEvent("download");
  await uiPage.getByRole("button", { name: "Download PDF again", exact: true }).click();
  assert.deepEqual(await readFile(await (await recoveredDownload).path()), await readFile("test-results/device-approved.pdf"));
  assert.equal((await uiCdp.send("WebAuthn.getCredentials", { authenticatorId: uiAuthenticatorId })).credentials[0].signCount, countBeforeReload, "Local-only recovery requires no new authentication");
  const cacheChecks = await uiPage.evaluate(async (nonce) => {
    const d = await import("/src/device.js"), { digest } = await import("/src/trust.js");
    const profile = await d.getDevice(), row = await d.getApprovalRecord(nonce);
    const recovered = await d.recoverApprovedOutput(row.record.intent.requestId);
    const update = async (value) => new Promise((resolve, reject) => {
      const open = indexedDB.open("inklark-device-v1", 2);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction("approvals", "readwrite");
        tx.objectStore("approvals").put(value);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = tx.onerror = () => { db.close(); reject(Error("Synthetic mutation failed")); };
      };
    });
    const corrupt = structuredClone(row);
    corrupt.output.ciphertext[0] ^= 1;
    await update(corrupt);
    let tamperingRejected = false;
    try { await d.recoverApprovedOutput(row.record.intent.requestId); }
    catch { tamperingRejected = true; }
    await update(row);
    const changedRetention = structuredClone(row);
    changedRetention.output.expiresAt += 1000;
    await update(changedRetention);
    let retentionTamperingRejected = false;
    try { await d.recoverApprovedOutput(row.record.intent.requestId); }
    catch { retentionTamperingRejected = true; }
    await update(row);
    await d.updateCachedOutput(nonce, { remove: true });
    const removed = !(await d.getApprovalRecord(nonce)).output;
    await update(row);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31 * 60000;
      await d.getRecoveryRequest();
    } finally { Date.now = realNow; }
    return {
      keyExtractable: profile.outputKey.key.extractable,
      recoveredHash: await digest(recovered.bytes),
      metadataContainsFilename: JSON.stringify({ ...row.output, ciphertext: undefined }).includes("Sample contact form"),
      tamperingRejected, retentionTamperingRejected,
      removed,
      expiredCopyRemoved: !(await d.getApprovalRecord(nonce)).output,
      proofRetained: !!(await d.getApprovalRecord(nonce)).record,
    };
  }, finalProof.intent.nonce);
  assert.equal(cacheChecks.keyExtractable, false);
  assert.equal(cacheChecks.recoveredHash, finalProof.intent.outputHash);
  assert.equal(cacheChecks.metadataContainsFilename, false);
  assert.ok(cacheChecks.tamperingRejected);
  assert.ok(cacheChecks.retentionTamperingRejected);
  assert.ok(cacheChecks.removed && cacheChecks.proofRetained);
  assert.ok(cacheChecks.expiredCopyRemoved);
  await uiPage.screenshot({
    path: "test-results/device-completed-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await ui.close();
  console.log(
    "Device checks passed: real WebAuthn assertions with a virtual authenticator, persisted non-extractable delivery key, encrypted handoff, pinned document/signer/edits, replay refusal, cancellation/retry, and mutation during authentication.",
  );
  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
