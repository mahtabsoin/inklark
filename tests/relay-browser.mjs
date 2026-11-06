import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { startRelayServer } from "../agent/relay-server.mjs";
import {
  prepareRemoteRequest,
  deliverRemoteRequest,
} from "../agent/remote-adapter.mjs";
import { demoPdf } from "../src/demo.js";
import { digest } from "../src/trust.js";

const parent = path.resolve(".local"),
  directory = path.join(parent, "relay-browser-" + randomUUID());
await mkdir(directory, { recursive: true });
const app = await startRelayServer({
  directory,
  port: 0,
  owner: "synthetic-browser-owner",
});
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
});
let callId = 0;
async function invoke(name, args = {}) {
  const response = await fetch(app.origin + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++callId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const result = (await response.json()).result;
  if (result.isError) throw Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    acceptDownloads: true,
  });
  const page = await context.newPage(),
    errors = [],
    external = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (
      !r.url().startsWith(app.origin) &&
      !r.url().startsWith("data:") &&
      !r.url().startsWith("blob:")
    )
      external.push(r.url());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  await page.goto(app.origin);
  await page.getByLabel("Your name for signing").fill("Jane Example");
  await page
    .getByRole("button", { name: "Set up device signing", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Connect your agent", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Connect your agent", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Copy connection address", exact: true })
    .waitFor();
  const target = await invoke("get_signing_device");
  assert.equal(target.signerName, "Jane Example");
  const expectedFingerprint = await page
    .locator("[data-device-fingerprint]")
    .getAttribute("data-device-fingerprint");
  assert.equal(expectedFingerprint, target.fingerprint);
  const bytes = await demoPdf();
  const items = [
    {
      id: "name",
      type: "field",
      fieldName: "full_name",
      page: 1,
      x: 56,
      y: 158,
      width: 500,
      height: 28,
      value: "Jane Example",
      source: "Synthetic test instruction",
    },
    {
      id: "signature",
      type: "signature",
      page: 1,
      x: 56,
      y: 510,
      width: 240,
      height: 45,
    },
  ];
  const beforePreparation = performance.now();
  const delivery = await prepareRemoteRequest(
    bytes,
    "Prepared by synthetic agent.pdf",
    items,
    target,
    { expectedFingerprint },
  );
  const preparationMs = Math.round(performance.now() - beforePreparation);
  const beforeDelivery = performance.now();
  const uploaded = await deliverRemoteRequest(delivery, invoke);
  assert.equal(uploaded.status, "pending");
  await page
    .getByRole("heading", { name: "Your document is ready.", exact: true })
    .waitFor();
  const handoffMs = Math.round(performance.now() - beforeDelivery);
  assert.equal(await page.locator('input[type="checkbox"]').count(), 0);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/relay-ready-mobile.png",
    fullPage: true,
  });
  const beforeCredential = (
    await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  ).credentials[0].signCount;
  let failOnce = true;
  await context.route("**/api/complete", (route) => {
    if (failOnce) {
      failOnce = false;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"Synthetic connection interruption"}',
      });
    }
    return route.continue();
  });
  const download = page.waitForEvent("download"),
    beforeSign = performance.now();
  await page
    .getByRole("button", { name: "Sign this document", exact: true })
    .click();
  await (await download).saveAs("test-results/relay-signed.pdf");
  await page
    .getByRole("heading", { name: "Your PDF is signed.", exact: true })
    .waitFor();
  const signingMs = Math.round(performance.now() - beforeSign);
  assert.equal(
    (await invoke("get_request_status", { request_id: uploaded.requestId }))
      .status,
    "pending",
  );
  await page
    .getByRole("button", { name: "Notify agent again", exact: true })
    .click();
  await page
    .getByText(
      "Your PDF is signed. Your agent received completion status only.",
      { exact: true },
    )
    .waitFor();
  const completion = await invoke("get_request_status", {
    request_id: uploaded.requestId,
  });
  assert.equal(completion.status, "completed");
  assert.equal(
    completion.receipt.outputHash,
    await digest(await readFile("test-results/relay-signed.pdf")),
  );
  const afterCredential = (
    await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  ).credentials[0].signCount;
  assert.equal(
    afterCredential,
    beforeCredential + 1,
    "A notification retry must not authenticate or sign again",
  );
  assert.equal(JSON.stringify(completion).includes("assertion"), false);
  assert.equal(JSON.stringify(completion).includes("base64"), false);
  assert.equal(JSON.stringify(completion).includes("Jane Example"), false);
  assert.equal(
    (await app.store.request("synthetic-browser-owner", uploaded.requestId))
      .payload_deleted,
    1,
  );
  await page.screenshot({
    path: "test-results/relay-completed-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    JSON.stringify({
      test: "Encrypted MCP-to-browser signing",
      result: "passed",
      preparationMs,
      handoffMs,
      signingMs,
      authenticator: "virtual CTAP2",
      note: "Loopback development timings; physical-phone and hosted-cloud timings are not measured.",
    }),
  );
  await context.close();
} finally {
  await browser.close();
  await app.close();
  if (
    path.dirname(directory) !== parent ||
    !path.basename(directory).startsWith("relay-browser-")
  )
    throw Error("Unsafe test cleanup path.");
  await rm(directory, { recursive: true, force: true });
}
