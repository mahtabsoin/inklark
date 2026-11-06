import "./sign.css";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  enrollDevice,
  getDevice,
  makeApprovalIntent,
  approveIntent,
} from "./device.js";
import { randomId, digest, fingerprint } from "./trust.js";
import { readPacket, makePacket, exportPdf } from "./core.js";
import { demoPdf } from "./demo.js";

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

function render() {
  const pending =
    prepared?.request.items.filter(
      (i) => i.needsReview && !acknowledgements.has(i.id),
    ) || [];
  root.innerHTML = `<div class="sign-shell"><header><a href="./sign.html" class="sign-brand"><img src="./icon.svg" width="42" height="42" alt=""><span>inklark</span></a><a href="./index.html">Open PDF editor</a></header><main>
    <p class="sign-eyebrow">${device ? "Your device controls signing" : "Set up signing on this device"}</p>
    <h1>${receipt ? "Your PDF is signed." : prepared ? "Your document is ready." : device ? "Ready when your agent is." : "Sign with device authentication."}</h1>
    <p class="sign-lead">${!device ? "Choose the name you use when signing, then set up your device credential. You can add handwriting separately." : prepared ? "Your agent prepared the document. Authentication approves this specific file and its signature locations." : "Your agent prepares the PDF. You authenticate here to sign it. This preview currently supports local requests; cloud delivery is being built."}</p>
    ${error ? `<p class="sign-error" role="alert">${esc(error)}</p>` : ""}${message ? `<p class="sign-message" role="status">${esc(message)}</p>` : ""}
    ${
      !device
        ? `<form id="device-setup" class="sign-card"><label for="signer-name">Your name for signing</label><input id="signer-name" name="name" autocomplete="name" maxlength="80" required><p class="sign-small">By setting up, you adopt this name as your typed signature. Setup asks you to create a credential and verify it. Later requests need one authentication.</p><button class="sign-primary" type="submit" ${busy ? "disabled" : ""}>Set up device signing</button></form>`
        : `<section class="sign-card"><div class="sign-profile"><span class="sign-avatar" aria-hidden="true">${esc(device.name.slice(0, 1))}</span><div><strong>${esc(device.name)}</strong><p>Device authentication required</p></div><span class="sign-tag">Paired locally</span></div>
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
      <div class="sign-actions"><button id="sign-now" class="sign-primary" ${busy || pending.length ? "disabled" : ""}>${busy ? "Waiting for authentication…" : receipt ? "Download PDF again" : "Sign this document"}</button><button id="inspect-document" class="sign-secondary" ${busy ? "disabled" : ""}>View document</button></div>${receipt ? '<button id="save-proof" class="sign-link">Save approval record</button>' : ""}`
        : `<div class="sign-actions"><button id="sample-request" class="sign-primary" ${busy ? "disabled" : ""}>Try a prepared sample</button><button id="open-request" class="sign-secondary" ${busy ? "disabled" : ""}>Open agent request</button></div>`
    }
    </section>`
    }
    <p class="sign-small sign-footnote">Signing and document processing happen on this device. Your chosen mark is a visual signature. Authentication evidence is separate from a certificate-backed PDF signature.</p>
    <div id="sign-preview" hidden><div class="sign-preview-heading"><strong>Document preview</strong><button id="close-preview" class="sign-link">Close</button></div><div id="preview-pages"></div></div>
    </main><footer>Free and open source · Device approval preview</footer></div><input type="file" id="request-file" accept=".json,.fillsign.json" hidden>`;
  document
    .querySelector("#device-setup")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = document.querySelector("#signer-name").value;
      run(async () => {
        device = await enrollDevice(name);
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
async function prepare(packet) {
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
    requestId: randomId(),
    expiresAt: Date.now() + 30 * 60000,
  };
  acknowledgements.clear();
  receipt = null;
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
    },
    device,
  );
  const approved = await approveIntent(intent);
  if (
    (await digest(prepared.bytes)) !== intent.outputHash ||
    (await fingerprint(prepared.packet)) !== prepared.packetHash
  )
    throw Error("The document changed. Prepare a new signing request.");
  receipt = approved;
  download(
    prepared.bytes,
    prepared.request.name.replace(/\.pdf$/i, "") + "-signed.pdf",
  );
  message =
    "Authentication approved this document. Your original is unchanged.";
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
  for (let number = 1; number <= preview.numPages; number++) {
    const page = await preview.getPage(number),
      base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: Math.min(
        1.1,
        (section.clientWidth - 32) / base.width,
        2200 / base.height,
      ),
    });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    pages.append(canvas);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport })
      .promise;
  }
  section.scrollIntoView({ behavior: "smooth", block: "start" });
}
render();
