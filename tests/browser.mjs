import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import {
  localServer,
  closeSessions,
  renderPreview,
  getStatus,
} from "../agent/engine.mjs";
import { demoPdf } from "../src/demo.js";
import { makePacket, exportPdf } from "../src/core.js";
import {
  encryptedFixture,
  pdfHelperAvailable,
  paintedAnswerFixture,
} from "./pdf-fixtures.mjs";
await mkdir("test-results", { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
});
const server = await localServer(null, { open: false, port: 0 });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const page = await context.newPage(),
  errors = [],
  external = [];
let staticServer = null;
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (
    !r.url().startsWith(server.origin) &&
    !r.url().startsWith("data:") &&
    !r.url().startsWith("blob:")
  )
    external.push(r.url());
});
try {
  const existingPage = await context.newPage();
  existingPage.on("pageerror", (e) => errors.push(e.message));
  await existingPage.goto(server.origin);
  const paintedBytes = await paintedAnswerFixture();
  await existingPage.locator("#file-input").setInputFiles({
    name: "existing-answers.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(paintedBytes),
  });
  const painted = existingPage.getByRole("textbox", {
    name: "painted_answer",
    exact: true,
    includeHidden: true,
  });
  await painted.waitFor();
  assert.equal(await painted.inputValue(), "");
  assert.equal(
    await existingPage
      .getByRole("textbox", { name: "saved_answer", exact: true })
      .inputValue(),
    "Saved sample answer",
  );
  const box = await painted.boundingBox();
  const clip = {
    x: box.x + 6,
    y: box.y + 6,
    width: box.width - 12,
    height: box.height - 12,
  };
  const screenshot = () => existingPage.screenshot({ clip, caret: "hide" });
  const visible = await screenshot();
  await painted.evaluate((el) => {
    el.style.visibility = "hidden";
  });
  const underlying = await screenshot();
  assert.ok(
    visible.equals(underlying),
    "An untouched empty control must preserve the page's painted answer",
  );
  await painted.evaluate((el) => {
    el.style.visibility = "";
  });
  await painted.focus();
  assert.ok(
    (await screenshot()).equals(underlying),
    "Focusing an empty control must preserve the painted answer",
  );
  await painted.fill("Updated sample answer");
  assert.equal(await painted.inputValue(), "Updated sample answer");
  assert.equal(
    await painted.evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(255, 255, 255)",
  );
  await painted.press("Tab");
  await existingPage.locator("#undo").click();
  assert.equal(await painted.inputValue(), "");
  assert.ok(
    (await screenshot()).equals(underlying),
    "Undo must restore visibility of the original painted answer",
  );
  await existingPage.locator("#file-input").setInputFiles({
    name: "exported-existing-answers.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await exportPdf(paintedBytes, [])),
  });
  await existingPage.waitForFunction(
    () => !document.querySelector("#native-fields input"),
  );
  assert.ok(
    (await screenshot()).equals(underlying),
    "Export must preserve the original painted answer",
  );
  await existingPage.close();
  await page.goto(server.origin);
  await page.screenshot({ path: "test-results/desktop-empty.png" });
  await page.getByRole("button", { name: /Try a sample form/ }).click();
  await page.locator("#native-fields input").first().waitFor();
  await page
    .getByRole("textbox", { name: "full_name", exact: true })
    .fill("Jane Example");
  await page
    .getByRole("textbox", { name: "email", exact: true })
    .fill("jane@example.test");
  await page.getByRole("textbox", { name: "email", exact: true }).press("Tab");
  await page
    .getByRole("button", { name: "Create your vault", exact: true })
    .click();
  await page
    .locator("#vault-password")
    .fill("a sufficiently long browser test password");
  await page
    .locator("#vault-repeat")
    .fill("a sufficiently long browser test password");
  await page.getByRole("button", { name: "Create vault", exact: true }).click();
  await page.locator("#add-signature").click();
  await page.locator("#signature-name").fill("Jane Example");
  await page.getByRole("tab", { name: "Type", exact: true }).click();
  await page.locator("#typed-signature").fill("Jane Example");
  await page
    .getByRole("button", { name: "Save signature", exact: true })
    .click();
  await page.locator(".modal").waitFor({ state: "detached" });
  const storage = await page.evaluate(() =>
    localStorage.getItem("fillsign.encrypted-vault.v1"),
  );
  assert.ok(storage);
  assert.equal(storage.includes("Jane Example"), false);
  assert.equal(storage.includes("data:image"), false);
  await page.locator("[data-place-sig]").click();
  const surface = page.locator("#page-surface"),
    scale = await surface.evaluate((el) => el.clientWidth / 612);
  await surface.click({ position: { x: 80 * scale, y: 500 * scale } });
  await page.screenshot({ path: "test-results/desktop-editing.png" });
  await page
    .getByRole("button", { name: "Review & finish", exact: true })
    .click();
  await page.locator("#review-canvas").waitFor();
  assert.equal(await page.locator("#finish").isDisabled(), true);
  await page.locator("#approve-signing").check();
  await page.screenshot({ path: "test-results/desktop-review.png" });
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#finish").click();
  const download = await downloadPromise;
  await download.saveAs("test-results/sample-signed.pdf");
  assert.equal(download.suggestedFilename(), "sample-contact-form-signed.pdf");
  const { PDFDocument } = await import("pdf-lib");
  const output = await PDFDocument.load(
    await readFile("test-results/sample-signed.pdf"),
  );
  assert.equal(output.getForm().getFields().length, 0);
  // Reload preserves the encrypted vault, while discarding the plaintext session.
  page.on("dialog", (dialog) => dialog.accept());
  await page.reload();
  await page
    .getByRole("button", { name: "Unlock vault", exact: true })
    .waitFor();
  const packet = await makePacket(await demoPdf(), "agent-form.pdf", [
    {
      id: "sensitive",
      type: "text",
      page: 1,
      x: 60,
      y: 620,
      width: 250,
      height: 25,
      value: "Verify this answer",
      sensitive: true,
      source: "An agent-reported source",
      question: "Check this against your authorized source.",
    },
  ]);
  await page.locator("#file-input").setInputFiles({
    name: "agent.fillsign.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(packet)),
  });
  await page
    .locator("#filename")
    .filter({ hasText: "agent-form.pdf" })
    .waitFor();
  await page.locator("#export").click();
  await page.locator("#confirm-field").waitFor();
  assert.equal(await page.locator(".review-modal").count(), 0);
  await page.locator("#confirm-field").check();
  await page.locator("#export").click();
  await page.locator("#review-canvas").waitFor();
  await page.locator("#back-edit").click();
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phone = await mobile.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.goto(server.origin);
  await phone.screenshot({ path: "test-results/mobile-empty.png" });
  await phone.locator("#sample").click();
  await phone.locator("#native-fields input").first().waitFor();
  await phone.locator('[data-tool="text"]').click();
  const phoneScale = await phone
    .locator("#page-surface")
    .evaluate((el) => el.clientWidth / 612);
  await phone
    .locator("#page-surface")
    .click({ position: { x: 60 * phoneScale, y: 620 * phoneScale } });
  await phone.locator("#item-value").fill("Mobile note");
  await phone.locator("#item-value").press("Tab");
  await phone.screenshot({ path: "test-results/mobile-editing.png" });
  assert.ok(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.ok(
    await phone
      .locator(".workspace")
      .evaluate((el) => el.getBoundingClientRect().right <= 390),
  );
  await mobile.close();
  // Real agent handoff: the secret goes to the human browser, while the agent
  // receives status and a receipt without the finished PDF or signature bytes.
  const bridgePacket = await makePacket(await demoPdf(), "bridge-form.pdf", [
    {
      id: "sign",
      type: "signature",
      page: 1,
      x: 60,
      y: 500,
      width: 160,
      height: 50,
      label: "Your signature",
    },
  ]);
  let signingUrl;
  const request = await localServer(bridgePacket, {
    openBrowser: (url) => {
      signingUrl = url;
    },
  });
  await page.goto(signingUrl);
  await page.locator(".overlay.signature").waitFor();
  assert.equal(new URL(page.url()).hash, "");
  assert.equal((await getStatus(request.sessionId)).status, "pending");
  await page.locator(".overlay.signature").click();
  await page.locator("#unlock-for-item").click();
  await page
    .locator("#vault-password")
    .fill("a sufficiently long browser test password");
  await page
    .getByRole("button", { name: "Unlock vault", exact: true })
    .last()
    .click();
  await page.locator("[data-sig]").click();
  await page.locator("#export").click();
  await page.locator("#approve-signing").check();
  const bridgeDownload = page.waitForEvent("download");
  await page.locator("#finish").click();
  await (await bridgeDownload).saveAs("test-results/bridge-signed.pdf");
  await page.locator(".modal").waitFor({ state: "detached" });
  const completion = await getStatus(request.sessionId);
  assert.equal(completion.status, "completed");
  assert.equal(completion.receipt.signatureCount, 1);
  assert.equal(JSON.stringify(completion).includes("base64"), false);
  if (pdfHelperAvailable) {
    const protectedPage = await context.newPage();
    protectedPage.on("pageerror", (e) => errors.push(e.message));
    await protectedPage.goto(server.origin);
    const encrypted = encryptedFixture(await demoPdf());
    await protectedPage.locator("#file-input").setInputFiles({
      name: "protected-no-password.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(encrypted),
    });
    await protectedPage.locator("#native-fields input").first().waitFor();
    assert.equal(
      await protectedPage.locator("#native-fields input").count(),
      2,
    );
    const passwordPdf = encryptedFixture(
      await demoPdf(),
      "synthetic-pdf-password",
    );
    await protectedPage.locator("#file-input").setInputFiles({
      name: "protected-with-password.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(passwordPdf),
    });
    await protectedPage.locator("#pdf-password").fill("synthetic-pdf-password");
    await protectedPage.locator("#pdf-password-form button").click();
    await protectedPage
      .locator("#filename")
      .filter({ hasText: "protected-with-password.pdf" })
      .waitFor();
    await protectedPage.locator("#pdf-password").waitFor({ state: "detached" });
    await protectedPage.screenshot({
      path: "test-results/protected-opened.png",
    });
    await protectedPage.close();
  }
  const setupPage = await context.newPage();
  await setupPage.goto(server.origin);
  await setupPage.locator("#agent-help").click();
  await setupPage.locator("#copy-agent-setup").waitFor();
  assert.equal(await setupPage.locator("details").getAttribute("open"), null);
  await setupPage.screenshot({ path: "test-results/agent-setup.png" });
  await setupPage.close();
  await writeFile("test-results/fixture.pdf", await demoPdf());
  const preview = await renderPreview("test-results/fixture.pdf", [], 1);
  assert.ok(preview.png.length > 1000);
  await writeFile("test-results/agent-preview.png", preview.png);
  // Exercise the hosted app under a subpath, including a genuine service-worker
  // offline reload. .localhost is a browser-trusted loopback testing origin.
  staticServer = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (!pathname.startsWith("/showcase/")) {
      res.writeHead(404).end();
      return;
    }
    const relative = pathname.slice("/showcase/".length) || "index.html";
    if (relative.includes("..") || relative.includes("\\")) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(path.join("dist", relative));
      const ext = path.extname(relative);
      res.setHeader(
        "Content-Type",
        {
          ".js": "text/javascript",
          ".mjs": "text/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".html": "text/html",
          ".svg": "image/svg+xml",
          ".wasm": "application/wasm",
          ".ttf": "font/ttf",
        }[ext] || "application/octet-stream",
      );
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => staticServer.listen(0, "127.0.0.1", resolve));
  const hosted = await browser.newContext(),
    offlinePage = await hosted.newPage();
  await offlinePage.goto(
    `http://fillsign.localhost:${staticServer.address().port}/showcase/`,
  );
  await offlinePage.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await offlinePage.waitForFunction(() => !!navigator.serviceWorker.controller);
  await hosted.setOffline(true);
  await offlinePage.reload();
  await offlinePage.locator("#sample").click();
  await offlinePage.locator("#native-fields input").first().waitFor();
  const cached = await offlinePage.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys())
        urls.push(request.url);
    return urls;
  });
  assert.ok(cached.length > 100);
  assert.equal(
    cached.some((url) => /\.(pdf|fillsign\.json|vault\.json)$/.test(url)),
    false,
  );
  await hosted.close();
  await new Promise((resolve) => staticServer.close(resolve));
  staticServer = null;
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: native fields, encrypted vault, saved signature, approval, PDF export, sensitive-answer gate, mobile layout, agent PNG preview, and no outbound requests.",
  );
} catch (e) {
  await page.screenshot({ path: "test-results/failure.png" }).catch(() => {});
  console.error(
    "Browser errors:",
    errors,
    "UI message:",
    await page
      .locator("#toast")
      .textContent()
      .catch(() => ""),
  );
  throw e;
} finally {
  await context.close();
  await browser.close();
  closeSessions();
  if (staticServer) await new Promise((resolve) => staticServer.close(resolve));
}
