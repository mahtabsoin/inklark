import "./sign.css";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  enrollDevice,
  getDevice,
  makeApprovalIntent,
  approveIntent,
  deviceRegistration,
  renewDeviceRegistration,
  getRecoveryRequest,
  recoverApprovedOutput,
  updateCachedOutput,
  hasRequestApproval,
} from "./device.js";
import { randomId, digest, fingerprint } from "./trust.js";
import { readPacket, makePacket, exportPdf } from "./core.js";
import { demoPdf } from "./demo.js";
import {
  openDelivery,
  deliveryFingerprint,
  verifyDeliveryTarget,
} from "./delivery.js";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const root = document.querySelector("#app");
const esc = (text) =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let device = await getDevice(),
  prepared = null,
  receipt = null,
  busy = false;
let error = "",
  message = "",
  preview = null;
const acknowledgements = new Set();
const failedRequests = new Set();
const handledRequests = new Set();
let relay = null,
  notificationPending = false,
  pollTimer = null,
  polling = false,
  activeUntil = Date.now() + 60000;
let pairingFingerprint = device
  ? await deliveryFingerprint({
      deviceId: device.deviceId,
      signerName: device.name,
      deliveryPublicKey: device.deliveryPublicKey,
      appearanceRevision: device.appearanceRevision,
    })
  : null;
async function api(path, body) {
  const response = await fetch(path, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(
      result.error || "The connection is unavailable. Retry in a moment.",
    );
  return result;
}
async function loadRelay() {
  try {
    const result = await api("/api/relay");
    if (result.mcpUrl !== location.origin + "/mcp")
      throw Error("The connection address does not match this Inklark host.");
    if (device && result.device?.deviceId === device.deviceId)
      await verifyDeliveryTarget(result.device, pairingFingerprint);
    relay = result;
  } catch {
    relay = null;
  }
}
async function pairDevice() {
  pairingFingerprint = await deliveryFingerprint({
    deviceId: device.deviceId,
    signerName: device.name,
    deliveryPublicKey: device.deliveryPublicKey,
    appearanceRevision: device.appearanceRevision,
  });
  await loadRelay();
  if (!relay) return;
  if (relay.device?.deviceId === device.deviceId) return;
  if (relay.device)
    throw Error(
      "Open Inklark on your already paired signing device. Its keys cannot be replaced here.",
    );
  if (relay.enrollmentEnabled === false)
    throw Error("Device setup is unavailable on this host while its authentication connection is being verified.");
  if (device.enrollment.intent.expiresAt <= Date.now())
    device = await renewDeviceRegistration();
  const result = await api("/api/device", deviceRegistration(device));
  relay.device = result.device;
  pairingFingerprint = await deliveryFingerprint({
    deviceId: device.deviceId,
    signerName: device.name,
    deliveryPublicKey: device.deliveryPublicKey,
    appearanceRevision: device.appearanceRevision,
  });
}

function render() {
  const pending =
    prepared?.request.items.filter(
      (i) => i.needsReview && !acknowledgements.has(i.id),
    ) || [];
  root.innerHTML = `<div class="sign-shell"><header><a href="./sign.html" class="sign-brand"><img src="./icon.svg" width="42" height="42" alt=""><span>inklark</span></a><a href="./index.html">Open PDF editor</a></header><main>
    <p class="sign-eyebrow">${device ? "Your device controls signing" : "Set up signing on this device"}</p>
    <h1>${receipt ? "Your PDF is signed." : prepared ? "Your document is ready." : device ? "Ready when your agent is." : "Sign with device authentication."}</h1>
    <p class="sign-lead">${!device ? "Choose the name you use when signing, then set up your device credential. You can add handwriting separately." : prepared ? "Your agent prepared the document. Authentication approves this specific file and its signature locations." : relay ? "Connect your agent once. Prepared documents arrive here encrypted for this device." : "Your agent prepares the PDF. You authenticate here to sign it. This local preview is not connected to a relay."}</p>
    ${error ? `<p class="sign-error" role="alert">${esc(error)}</p>` : ""}${message ? `<p class="sign-message" role="status">${esc(message)}</p>` : ""}
    ${
      !device
        ? relay?.device
          ? `<section class="sign-card"><strong>Use your paired signing device</strong><p class="sign-small">This connection is already paired with another device. Open Inklark there to receive and approve requests.</p></section>`
          : relay?.enrollmentEnabled === false
            ? `<section class="sign-card"><strong>Device setup is being verified</strong><p class="sign-small">This host is verifying its authentication connection before accepting signing devices.</p></section>`
            : `<form id="device-setup" class="sign-card"><label for="signer-name">Your name for signing</label><input id="signer-name" name="name" autocomplete="name" maxlength="80" required><p class="sign-small">By setting up, you adopt this name as your typed signature. Setup asks you to create a credential and verify it. Later requests need one authentication.</p><button class="sign-primary" type="submit" ${busy ? "disabled" : ""}>Set up device signing</button></form>`
        : `<section class="sign-card" data-device-fingerprint="${esc(pairingFingerprint || "")}"><div class="sign-profile"><span class="sign-avatar" aria-hidden="true">${esc(device.name.slice(0, 1))}</span><div><strong>${esc(device.name)}</strong><p>Device authentication required</p></div><span class="sign-tag">${relay?.device?.deviceId === device.deviceId ? "Connected" : "Paired locally"}</span></div>
    ${
      prepared
        ? `<div class="sign-document"><span aria-hidden="true">▤</span><div><strong>${esc(prepared.request.name)}</strong><p>${prepared.request.info.pages.length} ${prepared.request.info.pages.length === 1 ? "page" : "pages"} · ${prepared.signatureCount} ${prepared.signatureCount === 1 ? "signature location" : "signature locations"}</p></div></div>
      ${prepared.request.items
        .filter((i) => i.needsReview)
        .map(
          (i) =>
            `<label class="sign-question"><input type="checkbox" data-ack="${esc(i.id)}" ${acknowledgements.has(i.id) ? "checked" : ""} ${receipt || busy ? "disabled" : ""}><span>${esc(i.question || "Check this answer before signing.")}<strong>${esc(i.label || "Answer")}: ${esc(i.value)}</strong></span></label>`,
        )
        .join("")}
      <div class="sign-actions"><button id="sign-now" class="sign-primary" ${busy || pending.length ? "disabled" : ""}>${busy ? "Waiting for authentication…" : receipt ? "Download PDF again" : "Sign this document"}</button><button id="inspect-document" class="sign-secondary" ${busy ? "disabled" : ""}>View document</button></div>${receipt ? '<button id="save-proof" class="sign-link">Save approval record</button>' : ""}${notificationPending ? '<button id="retry-notification" class="sign-secondary">Notify agent again</button>' : ""}${receipt ? '<button id="next-request" class="sign-link">Back to requests</button>' : '<button id="cancel-request" class="sign-link">Dismiss request</button>'}`
        : `<div class="sign-actions">${relay ? (relay.device?.deviceId === device.deviceId ? '<button id="connect-agent" class="sign-primary">Connect your agent</button>' : '<button id="pair-device" class="sign-primary">Connect this device</button>') : ""}<button id="sample-request" class="${relay ? "sign-secondary" : "sign-primary"}" ${busy ? "disabled" : ""}>Try a prepared sample</button><button id="open-request" class="sign-secondary" ${busy ? "disabled" : ""}>Open agent request</button></div><div id="connection-guide" hidden><h2>Connect your agent</h2><ol><li>Open your agent's connectors or plugins.</li><li>Add Inklark using its connection address and complete sign-in.</li><li>Paste the pairing instructions into your agent conversation.</li></ol><button id="copy-connection" class="sign-secondary">Copy connection address</button><button id="copy-pairing" class="sign-secondary">Copy pairing instructions</button><p class="sign-small">Pairing verifies the destination before your agent sends a document. Your agent needs a runtime that can prepare and encrypt PDF artifacts.</p></div>`
    }
    </section>`
    }
    <p class="sign-small sign-footnote">The completed PDF is created on this device. Your agent provider processes information you give it; the relay stores encrypted document payloads. Device approval records are separate from certificate-backed PDF signatures.</p>
    <div id="sign-preview" hidden><div class="sign-preview-heading"><strong>Document preview</strong><button id="close-preview" class="sign-link">Close</button></div><div id="preview-pages"></div></div>
    </main><footer>Free and open source · Device approval preview</footer></div><input type="file" id="request-file" accept=".json,.fillsign.json" hidden>`;
  document
    .querySelector("#device-setup")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = document.querySelector("#signer-name").value;
      run(async () => {
        device = await enrollDevice(name);
        await pairDevice();
        message =
          "Device signing is ready. Your approval credential stays in your authenticator.";
      });
    });
  document.querySelector("#sample-request")?.addEventListener("click", () =>
    run(async () => {
      const bytes = await demoPdf();
      const packet = await makePacket(bytes, "Sample contact form.pdf", [
        {
          id: "name",
          type: "field",
          fieldName: "full_name",
          page: 1,
          x: 56,
          y: 158,
          width: 500,
          height: 28,
          value: device.name,
        },
        {
          id: "signature",
          type: "signature",
          page: 1,
          x: 56,
          y: 510,
          width: 240,
          height: 45,
          label: "Your signature",
        },
      ]);
      await prepare(packet);
    }),
  );
  document
    .querySelector("#pair-device")
    ?.addEventListener("click", () => run(pairDevice));
  document.querySelector("#connect-agent")?.addEventListener("click", () => {
    activeUntil = Date.now() + 60000;
    document.querySelector("#connection-guide").hidden = false;
  });
  document
    .querySelector("#copy-connection")
    ?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(relay.mcpUrl);
        message =
          "Connection address copied. Add it in your agent's connectors or plugins.";
      } catch {
        message = "Connection address: " + relay.mcpUrl;
      }
      render();
    });
  document
    .querySelector("#copy-pairing")
    ?.addEventListener("click", async () => {
      const instructions = `Use Inklark at ${location.origin}/mcp to prepare my PDFs and request my approval. My signing-device fingerprint, copied directly from my Inklark device, is ${pairingFingerprint}. Fetch get_signing_device and verify this exact fingerprint before uploading any document. Use agent/remote-adapter.mjs from https://github.com/mahtabsoin/inklark with expectedFingerprint set to this value. Prepare and encrypt artifacts in your own runtime, then send only ciphertext using the manifest/chunk tools. Give me the signing link. Only I authenticate and approve; never operate the signing screen or acquire signature assets or approval secrets. Ask about uncertain information before requesting approval.`;
      try {
        await navigator.clipboard.writeText(instructions);
        message =
          "Pairing instructions copied. Paste them into your agent conversation.";
      } catch {
        message =
          "Clipboard access was unavailable. Try this in your normal browser.";
      }
      render();
    });
  document
    .querySelector("#retry-notification")
    ?.addEventListener("click", () => run(notifyAgent));
  document.querySelector("#next-request")?.addEventListener("click", () => run(resetRequest));
  document.querySelector("#cancel-request")?.addEventListener("click", () => run(async () => {
    if (prepared.deliveryHash) await api("/api/cancel", { requestId: prepared.requestId });
    await resetRequest();
    message = "Request dismissed. Nothing was signed.";
  }));
  document
    .querySelector("#open-request")
    ?.addEventListener("click", () =>
      document.querySelector("#request-file").click(),
    );
  document
    .querySelector("#request-file")
    .addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (file)
        run(async () => {
          if (file.size > 45 * 1024 * 1024)
            throw Error("The agent request is too large.");
          await prepare(JSON.parse(await file.text()));
        });
    });
  for (const el of document.querySelectorAll("[data-ack]"))
    el.onchange = () => {
      el.checked
        ? acknowledgements.add(el.dataset.ack)
        : acknowledgements.delete(el.dataset.ack);
      render();
    };
  document
    .querySelector("#sign-now")
    ?.addEventListener("click", () => run(sign));
  document.querySelector("#inspect-document")?.addEventListener("click", () =>
    showPreview().catch((e) => {
      error = e.message;
      render();
    }),
  );
  document.querySelector("#close-preview")?.addEventListener("click", () => {
    document.querySelector("#sign-preview").hidden = true;
    preview?.destroy();
    preview = null;
  });
  document
    .querySelector("#save-proof")
    ?.addEventListener("click", () =>
      download(
        JSON.stringify(receipt, null, 2),
        "Inklark approval.json",
        "application/json",
      ),
    );
}
async function run(fn) {
  if (busy) return;
  busy = true;
  error = "";
  render();
  try {
    await fn();
  } catch (e) {
    error =
      e.name === "NotAllowedError"
        ? "Authentication was canceled. Nothing was signed."
        : e.message;
  } finally {
    busy = false;
    render();
  }
}
function typedMark(name) {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 240;
  const context = canvas.getContext("2d");
  context.font = "italic 96px Georgia";
  context.fillStyle = "#182c35";
  const scale = Math.min(1, 1140 / context.measureText(name).width);
  context.scale(scale, scale);
  context.fillText(name, 20, 150 / scale);
  return canvas.toDataURL("image/png");
}
async function prepare(packet, delivery = null) {
  const request = await readPacket(packet);
  const slots = request.items.filter((i) => i.type === "signature");
  if (!slots.length)
    throw Error("Ask your agent to include the proposed signature locations.");
  const signatures = new Map(slots.map((i) => [i.id, typedMark(device.name)]));
  const bytes = await exportPdf(request.bytes, request.items, { signatures });
  prepared = {
    packet,
    packetHash: await fingerprint(packet),
    request,
    bytes,
    signatureCount: slots.length,
    requestId: delivery?.manifest.route.requestId || randomId(),
    expiresAt: delivery?.manifest.route.expiresAt || Date.now() + 30 * 60000,
    deliveryHash: delivery?.deliveryHash,
  };
  const url = new URL(location.href);
  url.searchParams.set("request", prepared.requestId);
  history.replaceState(null, "", url);
  acknowledgements.clear();
  receipt = null;
  notificationPending = false;
  message = "";
}
async function sign() {
  if (!prepared) throw Error("Open a prepared request first.");
  if (receipt) {
    download(
      prepared.bytes,
      prepared.request.name.replace(/\.pdf$/i, "") + "-signed.pdf",
    );
    return;
  }
  if (prepared.expiresAt <= Date.now())
    throw Error("This request expired. Ask your agent to prepare a new request.");
  if (prepared.deliveryHash) {
    const current = await api("/api/status/" + prepared.requestId);
    if (current.status !== "pending")
      throw Error("This request is no longer awaiting approval. Ask your agent for its current status.");
  }
  if (
    prepared.request.items.some(
      (i) => i.needsReview && !acknowledgements.has(i.id),
    )
  )
    throw Error("Resolve the marked answers before signing.");
  const intent = await makeApprovalIntent(
    {
      requestId: prepared.requestId,
      documentHash: await digest(prepared.request.bytes),
      outputHash: await digest(prepared.bytes),
      editsHash: await fingerprint({
        items: prepared.request.items,
        acknowledgements: [...acknowledgements].sort(),
      }),
      expiresAt: prepared.expiresAt,
      ...(prepared.deliveryHash ? { deliveryHash: prepared.deliveryHash } : {}),
    },
    device,
  );
  const approved = await approveIntent(intent, {
    bytes: prepared.bytes,
    name: prepared.request.name,
    pages: prepared.request.info.pages.length,
    signatureCount: prepared.signatureCount,
  });
  if (
    (await digest(prepared.bytes)) !== intent.outputHash ||
    (await fingerprint(prepared.packet)) !== prepared.packetHash
  )
    throw Error("The document changed. Prepare a new signing request.");
  receipt = approved;
  handledRequests.add(prepared.requestId);
  download(
    prepared.bytes,
    prepared.request.name.replace(/\.pdf$/i, "") + "-signed.pdf",
  );
  message =
    "Authentication approved this document. Your original is unchanged.";
  if (prepared.deliveryHash) {
    notificationPending = true;
    try {
      await notifyAgent();
    } catch {
      message =
        "Your signed PDF is ready. The agent could not be notified. Retry notification here without signing again.";
    }
  }
}
async function notifyAgent() {
  if (!receipt || !prepared?.deliveryHash) return;
  await api("/api/complete", receipt);
  notificationPending = false;
  try { await updateCachedOutput(receipt.intent.nonce, { notified: true }); }
  catch {
    message = "Your agent received completion status. The local recovery status could not be saved.";
    return;
  }
  message = "Your PDF is signed. Your agent received completion status only.";
}
async function receiveRequest() {
  if (polling) return;
  polling = true;
  clearTimeout(pollTimer);
  try {
    if (
      document.visibilityState === "visible" &&
      device &&
      relay?.device?.deviceId === device.deviceId &&
      !prepared &&
      !busy
    ) {
      const inbox = await api("/api/inbox?device=" + device.deviceId);
      const wanted = new URL(location.href).searchParams.get("request");
      const delivery = inbox.requests.find(
        (r) => !failedRequests.has(r.manifest.route.requestId) && !handledRequests.has(r.manifest.route.requestId) && (!wanted || r.manifest.route.requestId === wanted),
      );
      if (delivery)
        await run(async () => {
          const requestId = delivery.manifest.route.requestId;
          if (await hasRequestApproval(requestId)) {
            handledRequests.add(requestId);
            if (!(await restoreLocalApproval(requestId)))
              message = "This request was already approved here. Its recovery copy is unavailable; use the PDF you downloaded.";
            return;
          }
          const chunks = [];
          for (let i = 0; i < delivery.manifest.chunks.length; i += 4) {
            const batch = await Promise.all(
              delivery.manifest.chunks
                .slice(i, i + 4)
                .map(async (_, offset) => {
                  const response = await fetch(
                    `/api/chunks/${delivery.manifest.route.requestId}/${i + offset}`,
                    { cache: "no-store" },
                  );
                  if (!response.ok)
                    throw Error(
                      "The encrypted request is unavailable. Ask your agent to retry delivery.",
                    );
                  return response.text();
                }),
            );
            chunks.push(...batch);
          }
          if ((await fingerprint(delivery.manifest)) !== delivery.deliveryHash)
            throw Error("The delivery manifest changed.");
          try {
            const packet = await openDelivery(
              delivery.manifest,
              chunks,
              device.deliveryPrivateKey,
              device.deviceId,
            );
            await prepare(packet, delivery);
          } catch (failure) {
            failedRequests.add(delivery.manifest.route.requestId);
            throw failure;
          }
        });
      else if (wanted && !prepared && !failedRequests.has(wanted)) {
        const current = await api("/api/status/" + wanted);
        if (["expired", "cancelled", "completed"].includes(current.status)) {
          failedRequests.add(wanted);
          message = `This request is ${current.status}. Your agent can prepare a new request when needed.`;
          render();
        }
      }
    }
  } catch {
    /* A transient connection failure must not approve or alter a draft. */
  } finally {
    polling = false;
    pollTimer = setTimeout(
      receiveRequest,
      document.visibilityState === "visible" && Date.now() < activeUntil
        ? 250
        : 3000,
    );
  }
}
async function resetRequest() {
  if (receipt && !notificationPending)
    await updateCachedOutput(receipt.intent.nonce, { remove: true });
  preview?.destroy();
  preview = null;
  prepared = null;
  receipt = null;
  notificationPending = false;
  acknowledgements.clear();
  const url = new URL(location.href);
  url.searchParams.delete("request");
  history.replaceState(null, "", url);
  activeUntil = Date.now() + 60000;
  message = "";
}
async function restoreLocalApproval(requestId) {
  if (!device) return false;
  const wanted = requestId || new URL(location.href).searchParams.get("request");
  const id = await getRecoveryRequest(wanted);
  if (!id) return false;
  const saved = await recoverApprovedOutput(id);
  if (!saved) return false;
  receipt = saved.record;
  handledRequests.add(receipt.intent.requestId);
  notificationPending = saved.notificationPending;
  prepared = {
    bytes: saved.bytes,
    request: { name: saved.name, info: { pages: Array(saved.pages) }, items: [] },
    signatureCount: saved.signatureCount,
    requestId: receipt.intent.requestId,
    expiresAt: receipt.intent.expiresAt,
    deliveryHash: receipt.intent.deliveryHash,
  };
  message = notificationPending
    ? "Your approved PDF was recovered. Retry agent notification without signing again."
    : "Your approved PDF was recovered on this device.";
  const url = new URL(location.href);
  url.searchParams.set("request", id);
  history.replaceState(null, "", url);
  return true;
}
function download(bytes, name, type = "application/pdf") {
  const blob = new Blob([bytes], { type }),
    url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function showPreview() {
  preview?.destroy();
  preview = await pdfjs.getDocument({
    data: prepared.bytes.slice(),
    isEvalSupported: false,
  }).promise;
  const section = document.querySelector("#sign-preview"),
    pages = document.querySelector("#preview-pages");
  section.hidden = false;
  pages.replaceChildren();
  const currentPreview = preview;
  let number = 1, rendering = false;
  const controls = document.createElement("div");
  controls.className = "sign-page-controls";
  const previous = document.createElement("button"), next = document.createElement("button"), label = document.createElement("span");
  previous.type = next.type = "button";
  previous.className = next.className = "sign-secondary";
  previous.textContent = "Previous page";
  next.textContent = "Next page";
  label.setAttribute("aria-live", "polite");
  controls.append(previous, label, next);
  const canvas = document.createElement("canvas");
  pages.append(controls, canvas);
  async function renderPage() {
    if (rendering || preview !== currentPreview) return;
    rendering = true;
    previous.disabled = next.disabled = true;
    const page = await currentPreview.getPage(number),
      base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: Math.min(
        1.1,
        (section.clientWidth - 32) / base.width,
        2200 / base.height,
      ),
    });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport })
      .promise;
    label.textContent = `${number} / ${currentPreview.numPages}`;
    previous.disabled = number === 1;
    next.disabled = number === currentPreview.numPages;
    rendering = false;
  }
  const pageFailure = (failure) => { error = failure.message; render(); };
  previous.onclick = () => { if (!rendering && number > 1) { number--; renderPage().catch(pageFailure); } };
  next.onclick = () => { if (!rendering && number < currentPreview.numPages) { number++; renderPage().catch(pageFailure); } };
  await renderPage();
  section.scrollIntoView({ behavior: "smooth", block: "start" });
}
await loadRelay();
try { await restoreLocalApproval(); }
catch { error = "The saved PDF could not be recovered. Your approval was preserved; nothing new was signed."; }
render();
receiveRequest();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    activeUntil = Date.now() + 60000;
    receiveRequest();
  }
});
