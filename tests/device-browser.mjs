import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { verifyApprovalRecord } from "../src/device.js";
import { randomId, sealRequest } from "../src/trust.js";

const server = createServer(async (request, response) => {
  if (request.url === "/")
    return response
      .writeHead(200, { "Content-Type": "text/html" })
      .end(
        '<!doctype html><title>Synthetic Inklark authentication test</title><script type="module">import * as device from "/src/device.js"; window.device = device;</script>',
      );
  if (
    request.url.startsWith("/assets/") ||
    request.url.startsWith("/pdf-assets/") ||
    ["/sign.html", "/icon.svg"].includes(request.url)
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
  if (!["/src/device.js", "/src/trust.js"].includes(request.url))
    return response.writeHead(404).end();
  response
    .writeHead(200, { "Content-Type": "text/javascript" })
    .end(await readFile("." + request.url));
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
  const profile = await page.evaluate(async () => {
    const p = await device.enrollDevice("Jane Example");
    return device.publicDevice(p);
  });
  assert.equal(profile.name, "Jane Example");
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
  await uiCdp.send("WebAuthn.addVirtualAuthenticator", {
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
  const { digest } = await import("../src/trust.js");
  assert.equal(
    await digest(await readFile("test-results/device-approved.pdf")),
    finalProof.intent.outputHash,
  );
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
