import "./style.css";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { icon } from "./icons.js";
import {
  loadPdf,
  inspectDocument,
  sha256,
  makePacket,
  readPacket,
  exportPdf,
  cleanName,
  MAX_BYTES,
  bytesToBase64,
  base64ToBytes,
} from "./core.js";
import {
  storedVault,
  createVault,
  unlockVault,
  saveVault,
  importVault,
} from "./vault.js";
import { demoPdf } from "./demo.js";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let vault = null,
  lastActivity = Date.now(),
  busy = false,
  currentRender = 0,
  renderingTask = null;
let history = [],
  future = [],
  bridge = null,
  modalCleanup = null;
const s = {
  bytes: null,
  pdf: null,
  info: null,
  name: "",
  hash: "",
  page: 1,
  scale: 1,
  tool: "cursor",
  items: [],
  selected: null,
  confirmed: new Set(),
  signatureChoice: null,
  note: "",
};

$("#app").innerHTML = `
  <header class="app-header">
    <a class="brand" href="./" aria-label="Inklark home"><img src="${import.meta.env.BASE_URL}icon.svg" alt="" width="44" height="44"><span>inklark</span></a>
    <div class="header-center"><span class="privacy-dot"></span> Local PDF workspace</div>
    <div class="header-actions"><button class="button subtle" id="open">${icon("open")}<span>Open PDF</span></button><button class="button primary" id="export" disabled>${icon("download")}<span>Review & finish</span></button></div>
  </header>
  <div class="toolbar" aria-label="PDF editing tools">
    <div class="tool-group">
      <button class="tool active" data-tool="cursor" title="Select and move (V)" aria-label="Select and move" aria-pressed="true">${icon("cursor")}</button>
      <span class="tool-divider"></span>
      <button class="tool" data-tool="text" title="Add text (T)">${icon("text")}<span>Text</span></button>
      <button class="tool" data-tool="check" title="Add checkmark (C)">${icon("box")}<span>Check</span></button>
      <button class="tool" data-tool="date" title="Add today's date (D)">${icon("calendar")}<span>Date</span></button>
      <button class="tool signature-tool" data-tool="signature" title="Place signature (S)">${icon("pen")}<span>Signature</span></button>
    </div>
    <div class="tool-group secondary-tools"><button class="tool" id="undo" title="Undo (Ctrl+Z)" aria-label="Undo" disabled>${icon("undo")}</button><button class="tool" id="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled>${icon("redo")}</button><span class="tool-divider"></span><button class="tool" id="zoom-out" aria-label="Zoom out">${icon("minus")}</button><button class="tool zoom" id="fit" title="Fit page width">100%</button><button class="tool" id="zoom-in" aria-label="Zoom in">${icon("plus")}</button></div>
    <button class="tool mobile-vault" id="mobile-vault" aria-label="Open signature vault">${icon("lock")}</button>
  </div>
  <main class="workspace">
    <aside class="page-sidebar" aria-label="Document pages"><div class="sidebar-heading">Pages <span id="page-count"></span></div><div id="thumbnails"></div><button class="sidebar-bottom" id="agent-help">${icon("agent")}<span>Connect your agent</span>${icon("chevron")}</button></aside>
    <section class="document-area" aria-label="PDF workspace">
      <div id="document-meta" hidden><div class="filename">${icon("file")}<span id="filename"></span></div><span id="doc-status"></span></div>
      <div id="empty-state">
        <div class="paper-illustration" aria-hidden="true"><div class="paper-fold"></div><div class="paper-line title-line"></div><div class="paper-line"></div><div class="paper-line short"></div><div class="paper-field"><span></span>${icon("check")}</div><svg class="ink" viewBox="0 0 160 50"><path d="M8 37C35-14 44-4 28 28S8 48 35 24c13-12 16-5 10 5s4 4 12-5 0 14 11 4 6 0 16-4 6 6 14 0 14-1 23-3m-90 20 107-8"/></svg></div>
        <h1>Your PDF, ready to finish.</h1><p>Fill a form and add your signature.<br>Everything is processed on this device.</p>
        <button class="button primary large" id="choose-pdf">${icon("plus")} Open a PDF</button>
        <span class="drop-hint">or drop a PDF or agent request here</span>
        <button class="text-button sample-button" id="sample">Try a sample form ${icon("arrow")}</button>
      </div>
      <div id="page-scroll" hidden><div id="page-surface"><canvas id="pdf-canvas"></canvas><div id="native-fields"></div><div id="overlays"></div></div></div>
      <div id="page-navigation" hidden><button class="tool" id="previous" aria-label="Previous page">${icon("chevron", "flip")}</button><span id="page-label"></span><button class="tool" id="next" aria-label="Next page">${icon("chevron")}</button></div>
      <div id="drop-overlay" hidden>${icon("open")}<strong>Drop to open</strong><span>PDF or agent request</span></div>
    </section>
    <aside class="details-sidebar" aria-label="Document details"><div id="inspector"></div><div id="vault-panel"></div><div class="local-note">${icon("shield")}<div><strong>Your files stay here</strong><p>Documents stay in this session. Saved signatures are encrypted on this device.</p><button class="text-button" id="privacy">How privacy works</button></div></div></aside>
  </main>
  <footer class="statusbar"><span id="hint">Open a PDF to get started</span><button id="about" class="text-button">Free & open source ${icon("info")}</button></footer>`;

function toast(message, error = false) {
  $("#toast").textContent = message;
  $("#toast").className = `visible ${error ? "error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").className = ""), 5500);
}
async function action(fn) {
  if (busy) return;
  busy = true;
  document.body.classList.add("busy");
  try {
    await fn();
  } catch (e) {
    console.error(e);
    toast(e.message || "Something went wrong. Try again.", true);
  } finally {
    busy = false;
    document.body.classList.remove("busy");
  }
}
function snapshot() {
  return JSON.stringify(s.items);
}
function remember() {
  history.push(snapshot());
  if (history.length > 80) history.shift();
  future = [];
}
function changed() {
  if (s.selected) s.confirmed.delete(s.selected);
  else s.confirmed.clear();
  updateChrome();
  renderOverlays();
  renderInspector();
}
function download(data, filename, type = "application/pdf") {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = cleanName(filename);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function closeModal() {
  if (modalCleanup) {
    const fn = modalCleanup;
    modalCleanup = null;
    fn();
  }
  $("#modal-root").replaceChildren();
}
function modal(title, body, footer = "") {
  closeModal();
  $("#modal-root").innerHTML =
    `<dialog class="modal" aria-labelledby="modal-title"><div class="modal-heading"><h2 id="modal-title">${title}</h2><button class="tool close-modal" aria-label="Close dialog">${icon("close")}</button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ""}</dialog>`;
  const dialog = $(".modal");
  dialog.showModal();
  $(".close-modal").onclick = closeModal;
  dialog.addEventListener("cancel", closeModal);
  dialog.addEventListener("click", (e) => {
    if (
      e.target === dialog &&
      (e.clientX < dialog.getBoundingClientRect().left ||
        e.clientX > dialog.getBoundingClientRect().right ||
        e.clientY < dialog.getBoundingClientRect().top ||
        e.clientY > dialog.getBoundingClientRect().bottom)
    )
      closeModal();
  });
  return dialog;
}
function pick() {
  $("#file-input").value = "";
  $("#file-input").click();
}
async function openFile(file) {
  if (!file) return;
  if (
    s.items.length &&
    !confirm("Open another document? Your current edits have not been saved.")
  )
    return;
  if (file.size > MAX_BYTES * 1.5)
    throw Error("Choose a PDF under 30 MB or a request under 45 MB.");
  if (/\.json$/i.test(file.name))
    await openPacket(JSON.parse(await file.text()));
  else {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      await openPdf(bytes, file.name);
    } catch (error) {
      if (!["ENCRYPTED_PDF", "UNREADABLE_PDF"].includes(error.code))
        throw error;
      await openProtectedPdf(bytes, file.name);
    }
  }
}
async function openProtectedPdf(bytes, name, password = "") {
  if (!["127.0.0.1", "localhost"].includes(location.hostname)) {
    modal(
      "Open this PDF locally",
      `<p>This PDF needs local compatibility support. The local app can create an editable copy while keeping the file and any password on your computer.</p><p class="muted">Start the local app, open it below, and choose this PDF again.</p><a class="button primary full" href="http://127.0.0.1:4319" target="_blank" rel="noopener">Open local app ${icon("arrow")}</a>`,
    );
    return;
  }
  const response = await fetch("./pdf/unlock", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Inklark-Action": "open-editable-copy",
    },
    body: JSON.stringify({ base64: bytesToBase64(bytes), password }),
  });
  if (response.status === 404)
    throw Error(
      "Restart the local app, then open this PDF again. Protected PDF support has been added.",
    );
  if (!response.ok)
    throw Error(
      "The local app could not open this PDF. Restart it and try again.",
    );
  const result = await response.json();
  if (result.ok) {
    await openPdf(base64ToBytes(result.base64), name);
    s.encryptedCopy = true;
    renderInspector();
    toast("Opened an editable copy locally. Your original is unchanged.");
    closeModal();
    return;
  }
  if (["PASSWORD_REQUIRED", "WRONG_PASSWORD"].includes(result.code)) {
    modal(
      "Enter the PDF password",
      `<p class="muted">The password opens an editable copy on this computer. It is not saved or sent to your agent.</p><form id="pdf-password-form"><label class="field-label" for="pdf-password">PDF opening password</label><input id="pdf-password" type="password" autocomplete="off" required><p class="inline-error" id="pdf-password-error">${result.code === "WRONG_PASSWORD" ? esc(result.message) : ""}</p><p class="fine-print">The original file is unchanged. Downloaded copies will not retain this PDF password.</p><button class="button primary full" type="submit">Open PDF ${icon("arrow")}</button></form>`,
    );
    $("#pdf-password-form").onsubmit = (e) => {
      e.preventDefault();
      const input = $("#pdf-password");
      const value = input.value;
      input.value = "";
      action(() => openProtectedPdf(bytes, name, value));
    };
    $("#pdf-password").focus();
    return;
  }
  if (result.code === "HELPER_UNAVAILABLE") {
    modal(
      "Add protected PDF support",
      `<p>The optional local PDF helper needs a one-time setup. Your agent can install it for you.</p><button class="button primary full" id="helper-setup">${icon("agent")} Copy setup request</button><p class="fine-print">Everything stays on this computer. Normal PDFs work without this helper.</p>`,
    );
    $("#helper-setup").onclick = () => copyAgentSetup(true);
    return;
  }
  throw Error(result.message || "This PDF could not be opened.");
}
async function openPacket(packet) {
  const request = await readPacket(packet);
  await openPdf(request.bytes, request.name, request.items, request.note);
  toast("Agent draft opened. Review marked answers before signing.");
}
async function openPdf(bytes, name, items = [], note = "") {
  const info = inspectDocument(await loadPdf(bytes));
  // Keep our original byte array: PDF.js transfers its copy to a worker.
  const base = new URL(import.meta.env.BASE_URL, location.href);
  const pdf = await pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    enableXfa: false,
    cMapUrl: new URL("pdf-assets/cmaps/", base).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("pdf-assets/standard_fonts/", base).href,
    wasmUrl: new URL("pdf-assets/wasm/", base).href,
  }).promise;
  if (s.pdf) await s.pdf.destroy();
  Object.assign(s, {
    bytes,
    name: cleanName(name),
    info,
    pdf,
    hash: await sha256(bytes),
    page: 1,
    items,
    selected: null,
    note,
    tool: "cursor",
    encryptedCopy: false,
  });
  if (bridge && bridge.requestHash !== s.hash) bridge = null;
  history = [];
  future = [];
  s.confirmed.clear();
  $("#empty-state").hidden = true;
  $("#page-scroll").hidden = false;
  $("#document-meta").hidden = false;
  $("#page-navigation").hidden = false;
  updateChrome();
  renderInspector();
  await renderPage(true);
  await renderThumbnails();
}
function updateChrome() {
  $("#export").disabled = !s.bytes;
  $("#undo").disabled = !history.length;
  $("#redo").disabled = !future.length;
  $("#filename").textContent = s.name;
  $("#page-count").textContent = s.pdf ? s.pdf.numPages : "";
  $("#page-label").textContent = s.pdf ? `${s.page} / ${s.pdf.numPages}` : "";
  $("#previous").disabled = s.page <= 1;
  $("#next").disabled = !s.pdf || s.page >= s.pdf.numPages;
  $("#fit").textContent = `${Math.round(s.scale * 100)}%`;
  const pending = s.items.filter(
    (i) => i.needsReview && !s.confirmed.has(i.id),
  ).length;
  $("#doc-status").textContent = pending
    ? `${pending} to review`
    : s.items.length
      ? `${s.items.length} edits`
      : "Ready to fill";
  $("#doc-status").className = pending ? "review-badge" : "";
  $(".workspace").classList.toggle("has-document", !!s.pdf);
  for (const el of document.querySelectorAll("[data-tool]")) {
    el.classList.toggle("active", el.dataset.tool === s.tool);
    el.setAttribute("aria-pressed", String(el.dataset.tool === s.tool));
  }
  $("#hint").textContent = !s.bytes
    ? "Open a PDF to get started"
    : s.tool === "cursor"
      ? "Click a field to edit. Drag added items to move them."
      : s.tool === "signature"
        ? "Click the page to place a signature. You will approve it before export."
        : `Click the page to add ${s.tool === "check" ? "a checkmark" : s.tool === "date" ? "today’s date" : "text"}.`;
  for (const el of document.querySelectorAll(".thumbnail"))
    el.classList.toggle("selected", Number(el.dataset.page) === s.page);
}
async function renderPage(fit = false) {
  if (!s.pdf) return;
  const id = ++currentRender,
    page = await s.pdf.getPage(s.page),
    viewport = page.getViewport({ scale: 1 });
  if (fit)
    s.scale = Math.min(
      1.25,
      Math.max(
        0.25,
        ($("#page-scroll").clientWidth - (innerWidth < 640 ? 28 : 80)) /
          viewport.width,
      ),
    );
  const size = page.getViewport({ scale: s.scale }),
    ratio = Math.min(
      devicePixelRatio || 1,
      2,
      Math.sqrt(16000000 / (size.width * size.height)),
      8000 / size.width,
      8000 / size.height,
    );
  if (renderingTask) {
    renderingTask.cancel();
    try {
      await renderingTask.promise;
    } catch {}
  }
  if (id !== currentRender) return;
  const canvas = $("#pdf-canvas");
  canvas.width = Math.ceil(size.width * ratio);
  canvas.height = Math.ceil(size.height * ratio);
  $("#page-surface").style.width = `${size.width}px`;
  $("#page-surface").style.height = `${size.height}px`;
  canvas.style.width = `${size.width}px`;
  canvas.style.height = `${size.height}px`;
  renderingTask = page.render({
    canvasContext: canvas.getContext("2d"),
    viewport: size,
    transform: [ratio, 0, 0, ratio, 0, 0],
    annotationMode: pdfjs.AnnotationMode.ENABLE,
  });
  try {
    await renderingTask.promise;
  } catch (e) {
    if (e.name !== "RenderingCancelledException") throw e;
  }
  if (id !== currentRender) return;
  renderNativeFields();
  renderOverlays();
  updateChrome();
}
async function renderThumbnails() {
  $("#thumbnails").replaceChildren();
  const pdf = s.pdf;
  for (let n = 1; n <= pdf.numPages; n++) {
    if (s.pdf !== pdf) return;
    const button = document.createElement("button");
    button.className = `thumbnail ${n === s.page ? "selected" : ""}`;
    button.dataset.page = n;
    button.setAttribute("aria-label", `Page ${n}`);
    const canvas = document.createElement("canvas"),
      label = document.createElement("span");
    label.textContent = n;
    button.append(canvas, label);
    $("#thumbnails").append(button);
    button.onclick = () => goPage(n);
    const page = await pdf.getPage(n),
      original = page.getViewport({ scale: 1 }),
      v = page.getViewport({
        scale: Math.min(108 / original.width, 150 / original.height),
      });
    canvas.width = v.width;
    canvas.height = v.height;
    canvas.style.width = `${v.width}px`;
    canvas.style.height = `${v.height}px`;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: v })
      .promise;
  }
}
function goPage(page) {
  if (!s.pdf || page < 1 || page > s.pdf.numPages) return;
  s.page = page;
  s.selected = null;
  renderInspector();
  action(() => renderPage());
}
function position(el, item) {
  Object.assign(el.style, {
    left: `${item.x * s.scale}px`,
    top: `${item.y * s.scale}px`,
    width: `${item.width * s.scale}px`,
    height: `${item.height * s.scale}px`,
  });
}
function renderNativeFields() {
  $("#native-fields").replaceChildren();
  if (!s.info) return;
  for (const f of s.info.fields.filter((f) => f.page === s.page)) {
    const item = s.items.find(
        (i) => i.type === "field" && i.fieldName === f.name,
      ),
      value = item?.value ?? f.value;
    const el = document.createElement(
      ["PDFDropdown", "PDFRadioGroup", "PDFOptionList"].includes(f.type)
        ? "select"
        : f.multiline
          ? "textarea"
          : "input",
    );
    el.className = "native-field";
    // Some PDFs paint answers into page content but leave their form values
    // empty. Keep untouched empty controls transparent so they cannot hide it.
    if (!item && (value === "" || value == null))
      el.classList.add("empty-original");
    el.oninput = () => el.classList.remove("empty-original");
    el.setAttribute("aria-label", f.name);
    el.title = f.name;
    position(el, f);
    if (f.type === "PDFCheckBox") {
      el.type = "checkbox";
      el.checked = !!value;
    } else if (el.tagName === "SELECT") {
      for (const v of ["", ...f.options]) el.add(new Option(v, v));
      el.value = value;
    } else {
      if (el.tagName === "INPUT") el.type = "text";
      el.value = value;
      el.style.fontSize = `${Math.min(12, f.height * 0.65) * s.scale}px`;
    }
    if (item?.needsReview && !s.confirmed.has(item.id))
      el.classList.add("needs-review");
    el.onfocus = () => {
      const current = s.items.find(
        (i) => i.type === "field" && i.fieldName === f.name,
      );
      s.selected = current?.id || null;
      renderInspector();
      if (current && innerWidth < 641)
        $(".details-sidebar").classList.add("mobile-open");
    };
    el.onchange = () => {
      remember();
      const original = s.items.find(
        (i) => i.type === "field" && i.fieldName === f.name,
      );
      const updated = {
        ...f,
        ...original,
        id: original?.id || crypto.randomUUID(),
        type: "field",
        fieldName: f.name,
        label: original?.label || f.name,
        fontSize: original?.fontSize || 12,
        value: f.type === "PDFCheckBox" ? el.checked : el.value,
      };
      delete updated.name;
      delete updated.options;
      s.items = s.items.filter(
        (i) => !(i.type === "field" && i.fieldName === f.name),
      );
      s.items.push(updated);
      s.selected = updated.id;
      changed();
    };
    $("#native-fields").append(el);
  }
}
function renderOverlays() {
  $("#overlays").replaceChildren();
  for (const item of s.items.filter(
    (i) => i.page === s.page && i.type !== "field",
  )) {
    const el = document.createElement("div");
    el.className = `overlay ${item.type} ${s.selected === item.id ? "selected" : ""} ${item.needsReview && !s.confirmed.has(item.id) ? "needs-review" : ""}`;
    el.dataset.id = item.id;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute(
      "aria-label",
      `${item.label}: ${item.type === "signature" ? "signature location" : item.value}`,
    );
    position(el, item);
    if (item.type === "signature") {
      const sig = vault?.signatures.find((sig) => sig.id === item.signerId);
      if (sig) {
        const img = document.createElement("img");
        img.src = sig.png;
        img.alt = sig.name;
        img.draggable = false;
        el.append(img);
      } else {
        el.innerHTML = `${icon("pen")}<span>${esc(item.label || "Signature")}</span>`;
      }
    } else if (item.type === "check")
      el.innerHTML = item.value ? icon("check") : "";
    else {
      el.textContent = item.value || "Type here";
      el.style.fontSize = `${item.fontSize * s.scale}px`;
      el.style.color = item.color;
      el.style.lineHeight = "1.2";
    }
    el.onpointerdown = (e) => beginDrag(e, item);
    el.onkeydown = (e) => {
      if (e.key === "Enter") {
        s.selected = item.id;
        renderInspector();
        renderOverlays();
      }
      if (e.key === "Delete") {
        removeSelected();
      }
    };
    el.ondblclick = () => {
      s.selected = item.id;
      renderInspector();
      $("#item-value")?.focus();
    };
    if (s.selected === item.id) {
      const handle = document.createElement("span");
      handle.className = "resize-handle";
      handle.title = "Resize";
      handle.onpointerdown = (e) => beginDrag(e, item, true);
      el.append(handle);
    }
    $("#overlays").append(el);
  }
}
function beginDrag(e, item, resize = false) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  s.selected = item.id;
  renderInspector();
  if (innerWidth < 641) $(".details-sidebar").classList.add("mobile-open");
  const el = e.currentTarget.closest(".overlay"),
    start = {
      x: e.clientX,
      y: e.clientY,
      ix: item.x,
      iy: item.y,
      w: item.width,
      h: item.height,
    },
    g = s.info.pages[item.page - 1];
  let moved = false;
  el.classList.add("selected");
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);
  target.onpointermove = (event) => {
    const dx = (event.clientX - start.x) / s.scale,
      dy = (event.clientY - start.y) / s.scale;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 2) return;
    if (!moved) {
      remember();
      moved = true;
      s.confirmed.clear();
    }
    if (resize) {
      item.width = Math.max(
        10,
        Math.min(g.displayWidth - item.x, start.w + dx),
      );
      item.height = Math.max(
        10,
        Math.min(g.displayHeight - item.y, start.h + dy),
      );
    } else {
      item.x = Math.max(
        0,
        Math.min(g.displayWidth - item.width, start.ix + dx),
      );
      item.y = Math.max(
        0,
        Math.min(g.displayHeight - item.height, start.iy + dy),
      );
    }
    position(el, item);
  };
  target.onpointerup = () => {
    target.onpointermove = null;
    target.onpointerup = null;
    renderOverlays();
    renderInspector();
    updateChrome();
  };
}
function renderInspector() {
  const item = s.items.find((i) => i.id === s.selected);
  const pending = s.items.filter(
    (i) => i.needsReview && !s.confirmed.has(i.id),
  );
  if (!item) {
    $("#inspector").innerHTML =
      `<div class="sidebar-section"><h2>${s.note ? "Agent draft" : "Document"}</h2><p class="muted">${s.note ? esc(s.note) : s.pdf ? "Fill existing form fields, or choose a tool and click the page." : "Open a PDF or try the sample form."}</p>${pending.length ? `<button class="review-link" id="review-pending">${icon("question")} ${pending.length} answers need review ${icon("chevron")}</button>` : ""}${s.pdf ? `<button class="text-button" id="save-request">Save unsigned draft ${icon("download")}</button>` : ""}</div>`;
    $("#review-pending")?.addEventListener("click", () =>
      selectItem(pending[0]),
    );
    $("#save-request")?.addEventListener("click", () =>
      action(async () =>
        download(
          JSON.stringify(await makePacket(s.bytes, s.name, s.items, s.note)),
          s.name.replace(/\.pdf$/i, "") + ".fillsign.json",
          "application/json",
        ),
      ),
    );
    return;
  }
  $("#inspector").innerHTML =
    `<div class="sidebar-section"><div class="section-heading"><h2>${item.type === "signature" ? "Signature placement" : item.type === "field" ? "Form field" : item.type === "check" ? "Checkmark" : "Text"}</h2><button class="tool danger" id="delete-item" aria-label="Delete selected item">${icon("trash")}</button></div>
    ${!["signature", "check"].includes(item.type) && typeof item.value !== "boolean" ? `<label class="field-label" for="item-value">${esc(item.label)}</label><textarea id="item-value" rows="3">${esc(item.value)}</textarea>` : ""}
    ${item.type === "signature" ? `<p class="muted">Choose whose signature belongs here. You approve signing at the end.</p><div id="signature-options">${vault?.signatures.length ? vault.signatures.map((sig) => `<button class="signature-option ${item.signerId === sig.id ? "chosen" : ""}" data-sig="${esc(sig.id)}"><img src="${sig.png}" alt=""><span>${esc(sig.name)}</span></button>`).join("") : `<button class="button secondary full" id="unlock-for-item">${icon("lock")} ${vault ? "Add a signature" : "Unlock signatures"}</button>`}</div>` : ""}
    ${item.type === "text" ? `<div class="field-row"><label>Size<input id="font-size" type="number" min="6" max="72" value="${item.fontSize}"></label><label>Ink<input id="ink-color" type="color" value="${item.color}"></label></div>` : ""}
    ${item.source ? `<div class="source-note"><strong>Agent-reported source</strong><p>${esc(item.source)}</p></div>` : ""}
    ${item.needsReview ? `<div class="review-note">${icon("question")}<p>${esc(item.question || (item.sensitive ? "Check this sensitive answer against a trusted source." : "Check this answer before signing."))}</p></div><label class="check-label"><input type="checkbox" id="confirm-field" ${s.confirmed.has(item.id) ? "checked" : ""}> I checked this answer</label>` : ""}
    <p class="placement-note">Page ${item.page}. Drag to move; use the corner to resize.</p></div>`;
  $("#delete-item").onclick = removeSelected;
  $("#item-value")?.addEventListener("change", (e) => {
    remember();
    item.value = e.target.value;
    changed();
    renderNativeFields();
  });
  $("#font-size")?.addEventListener("change", (e) => {
    remember();
    item.fontSize = Math.max(6, Math.min(72, Number(e.target.value) || 12));
    changed();
  });
  $("#ink-color")?.addEventListener("change", (e) => {
    remember();
    item.color = e.target.value;
    changed();
  });
  $("#confirm-field")?.addEventListener("change", (e) => {
    e.target.checked ? s.confirmed.add(item.id) : s.confirmed.delete(item.id);
    updateChrome();
    renderOverlays();
  });
  $("#unlock-for-item")?.addEventListener("click", () =>
    vault ? vaultManager() : vaultDialog(),
  );
  for (const button of document.querySelectorAll("[data-sig]"))
    button.onclick = () => {
      remember();
      item.signerId = button.dataset.sig;
      changed();
    };
}
function selectItem(item) {
  s.selected = item.id;
  if (item.page !== s.page) {
    s.page = item.page;
    action(() => renderPage());
  }
  renderInspector();
  renderOverlays();
  $(".details-sidebar").classList.add("mobile-open");
}
function removeSelected() {
  if (!s.selected) return;
  remember();
  s.items = s.items.filter((i) => i.id !== s.selected);
  s.selected = null;
  changed();
  renderNativeFields();
}
async function setTool(tool) {
  if (!s.pdf) {
    toast("Open a PDF first.");
    return;
  }
  if (tool === "signature" && !vault) {
    vaultDialog(() => setTool("signature"));
    return;
  }
  if (tool === "signature" && !vault.signatures.length) {
    vaultManager();
    return;
  }
  s.tool = tool;
  updateChrome();
}
$("#page-surface").addEventListener("pointerdown", (e) => {
  if (e.target.closest(".native-field") || e.target.closest(".overlay")) return;
  if (s.tool === "cursor") {
    s.selected = null;
    renderInspector();
    renderOverlays();
    return;
  }
  const rect = $("#page-surface").getBoundingClientRect(),
    g = s.info.pages[s.page - 1],
    type = s.tool === "date" ? "text" : s.tool;
  const sig =
    type === "signature"
      ? vault?.signatures.find((v) => v.id === s.signatureChoice) ||
        vault?.signatures[0]
      : null;
  let w = type === "check" ? 18 : type === "signature" ? 150 : 190,
    h =
      type === "check"
        ? 18
        : type === "signature"
          ? 150 / (sig?.ratio || 3)
          : 24;
  w = Math.min(w, g.displayWidth);
  h = Math.min(h, g.displayHeight);
  remember();
  const item = {
    id: crypto.randomUUID(),
    type,
    page: s.page,
    x: Math.max(
      0,
      Math.min(g.displayWidth - w, (e.clientX - rect.left) / s.scale),
    ),
    y: Math.max(
      0,
      Math.min(g.displayHeight - h, (e.clientY - rect.top) / s.scale),
    ),
    width: w,
    height: h,
    fontSize: 12,
    color: "#20332f",
    value:
      s.tool === "date"
        ? new Date().toLocaleDateString()
        : type === "check"
          ? true
          : "",
    label:
      type === "signature" ? "Signature" : s.tool === "date" ? "Date" : "Text",
    signerId: sig?.id,
  };
  s.items.push(item);
  s.selected = item.id;
  s.tool = "cursor";
  changed();
  if (innerWidth < 641) $(".details-sidebar").classList.add("mobile-open");
  if (type === "text") $("#item-value")?.focus();
});

function renderVault() {
  $("#vault-panel").innerHTML =
    `<div class="sidebar-section vault-section"><div class="section-heading"><h2>${icon("lock")} Your signatures</h2>${vault ? `<button class="text-button" id="lock-vault">Lock</button>` : '<span class="small-badge">Locked</span>'}</div>${vault ? `<div class="vault-signatures">${vault.signatures.map((sig) => `<button class="vault-signature" data-place-sig="${esc(sig.id)}"><img src="${sig.png}" alt=""><span>${esc(sig.name)}</span>${icon("plus")}</button>`).join("")}</div><button class="button secondary full" id="manage-vault">${icon("plus")} ${vault.signatures.length ? "Manage signatures" : "Add a signature"}</button>` : `<p class="muted">Save a signature once. Choose it when you need it.</p><button class="button secondary full" id="unlock-vault">${icon("lock")} ${storedVault() ? "Unlock vault" : "Create your vault"}</button><button class="text-button vault-import" id="import-vault">Import an encrypted vault</button>`}</div>`;
  $("#unlock-vault")?.addEventListener("click", () => vaultDialog());
  $("#lock-vault")?.addEventListener("click", lockVault);
  $("#manage-vault")?.addEventListener("click", vaultManager);
  $("#import-vault")?.addEventListener("click", pickVaultImport);
  for (const el of document.querySelectorAll("[data-place-sig]"))
    el.onclick = () => {
      s.signatureChoice = el.dataset.placeSig;
      setTool("signature");
    };
}
function lockVault() {
  vault = null;
  s.signatureChoice = null;
  closeModal();
  renderVault();
  renderOverlays();
  renderInspector();
  toast("Vault locked.");
}
function vaultDialog(after) {
  const exists = !!storedVault();
  modal(
    exists ? "Unlock your signatures" : "Create your signature vault",
    `<p class="muted">${exists ? "Your password decrypts signatures on this device." : "Your signatures are encrypted on this device. Keep your password safe; there is no password reset."}</p><form id="vault-form"><label class="field-label" for="vault-password">${exists ? "Vault password" : "Choose a password"}</label><input id="vault-password" type="password" autocomplete="${exists ? "current-password" : "new-password"}" minlength="${exists ? 1 : 12}" required placeholder="${exists ? "Your vault password" : "At least 12 characters"}">${exists ? "" : `<label class="field-label" for="vault-repeat">Repeat password</label><input id="vault-repeat" type="password" autocomplete="new-password" required>`}<p id="vault-error" class="inline-error" role="alert"></p><button class="button primary full" type="submit">${icon("lock")} ${exists ? "Unlock vault" : "Create vault"}</button></form>`,
  );
  $("#vault-form").onsubmit = async (e) => {
    e.preventDefault();
    const button = $("#vault-form button");
    button.disabled = true;
    try {
      const password = $("#vault-password").value;
      if (!exists && password !== $("#vault-repeat").value)
        throw Error("The passwords do not match.");
      vault = exists
        ? await unlockVault(storedVault(), password)
        : await createVault(password);
      await saveVault(vault);
      lastActivity = Date.now();
      closeModal();
      renderVault();
      renderInspector();
      renderOverlays();
      if (after) after();
      else if (!vault.signatures.length) vaultManager();
    } catch (err) {
      $("#vault-error").textContent = err.message;
      button.disabled = false;
    }
  };
  $("#vault-password").focus();
}
function pickVaultImport() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = () =>
    action(async () => {
      const file = input.files[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024)
        throw Error("The vault file is too large.");
      if (
        storedVault() &&
        !confirm(
          "Replace this device’s encrypted vault? Export a backup first if you need its signatures.",
        )
      )
        return;
      importVault(await file.text());
      vault = null;
      renderVault();
      renderOverlays();
      renderInspector();
      vaultDialog();
    });
  input.click();
}
function vaultManager() {
  if (!vault) {
    vaultDialog(vaultManager);
    return;
  }
  modal(
    "Your signature vault",
    `<p class="muted">Only this device holds your unlocked signatures. Approval is required when you finish a document.</p><div class="manage-list">${vault.signatures.map((sig) => `<div class="manage-signature"><img src="${sig.png}" alt=""><span>${esc(sig.name)}</span><button class="tool danger" data-remove-sig="${esc(sig.id)}" aria-label="Delete ${esc(sig.name)}">${icon("trash")}</button></div>`).join("") || '<p class="empty-list">Add your first signature below.</p>'}</div><button class="button secondary full" id="add-signature">${icon("plus")} Add a signature</button><div class="vault-actions"><button class="text-button" id="backup-vault">${icon("download")} Export encrypted backup</button><button class="text-button" id="replace-vault">Import vault</button></div><p class="fine-print">Browser data can be cleared. Keep an encrypted backup. Anyone who can view a signed PDF can copy the visible signature.</p>`,
  );
  $("#add-signature").onclick = signatureDialog;
  $("#backup-vault").onclick = () =>
    download(storedVault(), "signatures.vault.json", "application/json");
  $("#replace-vault").onclick = pickVaultImport;
  for (const button of document.querySelectorAll("[data-remove-sig]"))
    button.onclick = () =>
      action(async () => {
        if (!confirm("Delete this saved signature?")) return;
        const old = vault.signatures;
        vault.signatures = old.filter(
          (sig) => sig.id !== button.dataset.removeSig,
        );
        try {
          await saveVault(vault);
        } catch (e) {
          vault.signatures = old;
          throw e;
        }
        renderVault();
        renderOverlays();
        renderInspector();
        vaultManager();
      });
}
function signatureDialog() {
  if (vault.signatures.length >= 20) {
    toast("This vault holds up to 20 signatures.", true);
    return;
  }
  modal(
    "Add a signature",
    `<label class="field-label" for="signature-name">Whose signature is this?</label><input id="signature-name" placeholder="Name or label" maxlength="80"><div class="tabs" role="tablist"><button class="tab active" data-tab="draw" role="tab" aria-selected="true">Draw</button><button class="tab" data-tab="type" role="tab" aria-selected="false">Type</button><button class="tab" data-tab="upload" role="tab" aria-selected="false">Upload</button></div><div id="signature-content"></div><p id="signature-error" class="inline-error" role="alert"></p><p class="fine-print">Save signatures you are authorized to use. This creates a visual signature.</p>`,
    `<button class="button subtle" id="cancel-signature">Cancel</button><button class="button primary" id="save-signature">Save signature</button>`,
  );
  let mode = "draw",
    ink = false,
    uploaded = null;
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 320;
  canvas.className = "draw-canvas";
  canvas.setAttribute("aria-label", "Draw your signature here");
  let ctx = canvas.getContext("2d");
  ctx.strokeStyle = "#152d40";
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  function drawPanel() {
    const area = $("#signature-content");
    if (mode === "draw") {
      area.innerHTML =
        '<div class="draw-pad"><span class="draw-guide">Draw your signature</span></div><button class="text-button" id="clear-ink">Clear</button>';
      $(".draw-pad").append(canvas);
      $("#clear-ink").onclick = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ink = false;
      };
    } else if (mode === "type") {
      area.innerHTML =
        '<label class="sr-only" for="typed-signature">Type your signature</label><input class="typed-signature" id="typed-signature" placeholder="Your signature" maxlength="80">';
    } else {
      area.innerHTML =
        '<label class="upload-signature">' +
        icon("upload") +
        '<span>Choose a signature image</span><small>PNG, JPG or WebP, up to 5 MB</small><input id="signature-upload" type="file" accept="image/png,image/jpeg,image/webp" hidden></label><div id="upload-preview"></div>';
      $("#signature-upload").onchange = () =>
        action(async () => {
          const file = $("#signature-upload").files[0];
          if (!file) return;
          if (file.size > 5 * 1024 * 1024)
            throw Error("Choose an image under 5 MB.");
          if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
            throw Error("Choose a PNG, JPG or WebP image.");
          const image = await createImageBitmap(file);
          if (image.width * image.height > 16000000) {
            image.close();
            throw Error("Choose an image smaller than 16 megapixels.");
          }
          const temp = document.createElement("canvas");
          const factor = Math.min(1, 1000 / image.width, 500 / image.height);
          temp.width = Math.round(image.width * factor);
          temp.height = Math.round(image.height * factor);
          const c = temp.getContext("2d");
          c.drawImage(image, 0, 0, temp.width, temp.height);
          image.close();
          const pixels = c.getImageData(0, 0, temp.width, temp.height);
          for (let i = 0; i < pixels.data.length; i += 4) {
            const light = Math.min(
              pixels.data[i],
              pixels.data[i + 1],
              pixels.data[i + 2],
            );
            if (light > 220)
              pixels.data[i + 3] = Math.round(
                (pixels.data[i + 3] * (255 - light)) / 35,
              );
          }
          c.putImageData(pixels, 0, 0);
          uploaded = cropCanvas(temp);
          $("#upload-preview").innerHTML =
            `<img src="${uploaded.png}" alt="Uploaded signature preview">`;
        });
    }
  }
  canvas.onpointerdown = (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo(
      ((e.clientX - r.left) * canvas.width) / r.width,
      ((e.clientY - r.top) * canvas.height) / r.height,
    );
    ctx.lineTo(
      ((e.clientX - r.left) * canvas.width) / r.width + 0.1,
      ((e.clientY - r.top) * canvas.height) / r.height + 0.1,
    );
    ctx.stroke();
    ink = true;
    canvas.onpointermove = (ev) => {
      const b = canvas.getBoundingClientRect();
      ctx.lineTo(
        ((ev.clientX - b.left) * canvas.width) / b.width,
        ((ev.clientY - b.top) * canvas.height) / b.height,
      );
      ctx.stroke();
    };
  };
  canvas.onpointerup = () => (canvas.onpointermove = null);
  canvas.onpointercancel = () => (canvas.onpointermove = null);
  for (const button of document.querySelectorAll("[data-tab]"))
    button.onclick = () => {
      mode = button.dataset.tab;
      for (const b of document.querySelectorAll("[data-tab]")) {
        b.classList.toggle("active", b === button);
        b.setAttribute("aria-selected", String(b === button));
      }
      drawPanel();
    };
  $("#cancel-signature").onclick = vaultManager;
  $("#save-signature").onclick = () =>
    action(async () => {
      try {
        if (!vault) throw Error("Unlock your vault again.");
        const name = $("#signature-name").value.trim();
        if (!name) throw Error("Add a name for this signature.");
        let result;
        if (mode === "draw") {
          if (!ink) throw Error("Draw your signature first.");
          result = cropCanvas(canvas);
        } else if (mode === "type") {
          const text = $("#typed-signature").value.trim();
          if (!text) throw Error("Type your signature first.");
          const t = document.createElement("canvas");
          t.width = 1000;
          t.height = 200;
          const c = t.getContext("2d");
          c.font = "italic 84px cursive";
          c.fillStyle = "#152d40";
          c.fillText(text, 15, 125, 970);
          result = cropCanvas(t);
        } else {
          if (!uploaded) throw Error("Choose a signature image first.");
          result = uploaded;
        }
        const sig = {
          id: crypto.randomUUID(),
          name,
          png: result.png,
          ratio: result.ratio,
        };
        vault.signatures.push(sig);
        try {
          await saveVault(vault);
        } catch (e) {
          vault.signatures.pop();
          throw e;
        }
        s.signatureChoice = sig.id;
        closeModal();
        renderVault();
        renderInspector();
        toast("Signature saved in your encrypted vault.");
      } catch (e) {
        $("#signature-error").textContent = e.message;
      }
    });
  drawPanel();
  $("#signature-name").focus();
}
function cropCanvas(canvas) {
  const c = canvas.getContext("2d"),
    { data, width, height } = c.getImageData(0, 0, canvas.width, canvas.height);
  let x1 = width,
    y1 = height,
    x2 = 0,
    y2 = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 30) {
        x1 = Math.min(x1, x);
        y1 = Math.min(y1, y);
        x2 = Math.max(x2, x);
        y2 = Math.max(y2, y);
      }
  if (x2 < x1 || y2 < y1) throw Error("The signature image is empty.");
  const out = document.createElement("canvas");
  out.width = x2 - x1 + 13;
  out.height = y2 - y1 + 13;
  out
    .getContext("2d")
    .drawImage(
      canvas,
      x1,
      y1,
      x2 - x1 + 1,
      y2 - y1 + 1,
      6,
      6,
      x2 - x1 + 1,
      y2 - y1 + 1,
    );
  return { png: out.toDataURL("image/png"), ratio: out.width / out.height };
}

async function review() {
  if (!s.bytes) return;
  const pending = s.items.filter(
    (i) => i.needsReview && !s.confirmed.has(i.id),
  );
  if (pending.length) {
    selectItem(pending[0]);
    toast(
      `Check ${pending.length} marked ${pending.length === 1 ? "answer" : "answers"} before finishing.`,
      true,
    );
    return;
  }
  const missing = s.items.find(
    (i) =>
      i.type === "signature" &&
      !vault?.signatures.find((sig) => sig.id === i.signerId),
  );
  if (missing) {
    selectItem(missing);
    if (!vault) vaultDialog();
    else toast("Choose a saved signature for this location.", true);
    return;
  }
  const required = s.info.fields.find(
    (f) =>
      f.required &&
      !(s.items.find((i) => i.fieldName === f.name)?.value ?? f.value),
  );
  if (required) {
    s.page = required.page;
    await renderPage();
    toast(`Fill the required field: ${required.name}`, true);
    return;
  }
  const itemSnapshot = snapshot(),
    originalHash = s.hash,
    signatures = new Map();
  for (const item of s.items.filter((i) => i.type === "signature"))
    signatures.set(
      item.id,
      vault.signatures.find((sig) => sig.id === item.signerId).png,
    );
  const bytes = await exportPdf(s.bytes, s.items, { signatures });
  const outputHash = await sha256(bytes);
  const preview = await pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
  }).promise;
  const signatureCount = signatures.size;
  const pages = [...new Set(s.items.map((i) => i.page))];
  if (!pages.length) pages.push(s.page);
  modal(
    signatureCount ? "Review and approve signing" : "Review your finished PDF",
    `<p class="muted">${signatureCount ? `Apply ${signatureCount === 1 ? "the selected signature" : `${signatureCount} signatures`} to the locations shown below. You can inspect every page.` : "Check your filled answers before downloading."}</p><div class="review-controls"><button class="tool" id="review-prev" aria-label="Previous review page">${icon("chevron", "flip")}</button><span id="review-page-label"></span><button class="tool" id="review-next" aria-label="Next review page">${icon("chevron")}</button></div><div class="review-canvas-wrap"><canvas id="review-canvas"></canvas></div><div class="review-summary">${s.items
      .filter((i) => i.type === "signature")
      .map(
        (i) =>
          `<span>${icon("pen")}${esc(vault.signatures.find((sig) => sig.id === i.signerId).name)} · Page ${i.page}</span>`,
      )
      .join(
        "",
      )}</div>${signatureCount ? '<label class="check-label approval-check"><input id="approve-signing" type="checkbox"> I approve these signatures on this document.</label>' : ""}<p class="fine-print">${bridge ? "Your agent receives completion status only. The signed PDF downloads directly to you." : "The finished PDF downloads to this device."} ${s.encryptedCopy ? "This copy does not retain the original PDF password. " : ""}Visual signatures can be copied by anyone who receives the PDF.</p>`,
    `<button class="button subtle" id="back-edit">Keep editing</button><button class="button primary" id="finish" ${signatureCount ? "disabled" : ""}>${icon("download")} ${signatureCount ? "Approve & download" : "Download PDF"}</button>`,
  );
  $(".modal").classList.add("review-modal");
  let pageNumber =
      s.items.find((i) => i.type === "signature")?.page || pages[0],
    previewTask = null;
  modalCleanup = () => {
    previewTask?.cancel();
    preview.destroy();
    signatures.clear();
  };
  async function paint() {
    const page = await preview.getPage(pageNumber),
      original = page.getViewport({ scale: 1 }),
      width = Math.min(650, $(".review-canvas-wrap").clientWidth - 24),
      v = page.getViewport({
        scale: Math.min(width / original.width, 3000 / original.height),
      });
    const canvas = $("#review-canvas");
    if (!canvas) return;
    if (previewTask) {
      previewTask.cancel();
      try {
        await previewTask.promise;
      } catch {}
    }
    canvas.width = v.width * 1.5;
    canvas.height = v.height * 1.5;
    canvas.style.width = `${v.width}px`;
    canvas.style.height = `${v.height}px`;
    previewTask = page.render({
      canvasContext: canvas.getContext("2d"),
      viewport: v,
      transform: [1.5, 0, 0, 1.5, 0, 0],
    });
    await previewTask.promise;
    $("#review-page-label").textContent =
      `Page ${pageNumber} of ${preview.numPages}`;
    $("#review-prev").disabled = pageNumber === 1;
    $("#review-next").disabled = pageNumber === preview.numPages;
    const wrap = $(".review-canvas-wrap"),
      slot = s.items.find(
        (i) => i.type === "signature" && i.page === pageNumber,
      );
    wrap.scrollTop = slot
      ? Math.max(0, slot.y * v.scale - wrap.clientHeight * 0.35)
      : 0;
  }
  $("#review-prev").onclick = () => {
    if (pageNumber > 1) {
      pageNumber--;
      action(paint);
    }
  };
  $("#review-next").onclick = () => {
    if (pageNumber < preview.numPages) {
      pageNumber++;
      action(paint);
    }
  };
  $("#approve-signing")?.addEventListener(
    "change",
    (e) => ($("#finish").disabled = !e.target.checked),
  );
  $("#back-edit").onclick = closeModal;
  $("#finish").onclick = () =>
    action(async () => {
      if (
        snapshot() !== itemSnapshot ||
        (await sha256(s.bytes)) !== originalHash
      )
        throw Error("The document changed. Review it again.");
      if (signatureCount && (!vault || !$("#approve-signing")?.checked))
        throw Error("Unlock your vault and approve signing again.");
      $("#finish").disabled = true;
      download(
        bytes,
        s.name.replace(/\.pdf$/i, "") +
          (signatureCount ? "-signed.pdf" : "-filled.pdf"),
      );
      let notificationFailed = false;
      if (bridge) {
        try {
          const response = await fetch(bridge.origin + "/complete", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${bridge.token}`,
            },
            body: JSON.stringify({
              requestHash: bridge.requestHash,
              outputHash,
              status: "completed",
              signatureCount,
            }),
          });
          if (!response.ok) throw Error("Completion receipt rejected.");
          bridge = null;
        } catch {
          notificationFailed = true;
        }
      }
      closeModal();
      toast(
        notificationFailed
          ? "PDF downloaded. Your agent could not be notified."
          : "PDF downloaded. Your original is unchanged.",
        notificationFailed,
      );
    });
  await paint();
}

async function copyAgentSetup(helperOnly = false) {
  try {
    let setup = null;
    if (["127.0.0.1", "localhost"].includes(location.hostname)) {
      const response = await fetch("./setup");
      if (response.ok) setup = await response.json();
    }
    const prompt = helperOnly
      ? `Set up Inklark's optional local protected-PDF support. ${setup ? `The source folder is ${JSON.stringify(setup.project)}.` : "Ask me for the local Inklark source folder."} Use Python 3 and install requirements-pdf.txt from that folder. This is a local-only pikepdf helper. Restart the local launcher if necessary, after asking me to save any open draft. Do not open my documents, read my signature vault, or request my PDF/vault passwords. Tell me when I can retry opening my PDF.`
      : `Connect Inklark, my local PDF editor, to this agent client. ${setup ? `The source folder is ${JSON.stringify(setup.project)} and the MCP server is ${JSON.stringify(setup.server)}.` : "Ask me for the local Inklark source folder, or help me install the public source."} Read docs/AGENT.md and SECURITY.md in that folder. Ask which document folder I authorize you to access. Register agent/mcp.mjs as a local stdio MCP server using this client's supported configuration, with FILLSIGN_WORKSPACE set only to that folder. Check the client's help if needed. Build the app if necessary. Do not read signature assets, vault contents, or passwords. When I ask you to fill a PDF, behave as a careful executive assistant: use reliable authorized information, verify sensitive facts, ask focused questions about uncertainty, and render the proposed result. Open the draft for my review. Only I approve applying a signature. Tell me briefly when the connection is ready.`;
    await navigator.clipboard.writeText(prompt);
    toast("Setup request copied. Paste it into your agent.");
  } catch {
    toast("Could not copy. Use the manual setup instructions below.", true);
  }
}
function agentHelp() {
  modal(
    "Connect your agent",
    `<div class="setup-illustration">${icon("agent")}<span></span>${icon("pen")}</div><p class="setup-lead">Let your agent handle the setup.</p><p class="muted">Copy the request below and paste it into the agent you already use. It will connect the tools and ask which document folder it may access.</p><button class="button primary full" id="copy-agent-setup">${icon("agent")} Copy setup request</button><p class="fine-print">You do this once. Afterward, ask your agent to fill a PDF and open it for your review. Signing always needs your approval.</p><details><summary>Manual setup</summary><p class="muted">Run the app locally, then add this server in your agent client's MCP settings. Choose an authorized document folder for FILLSIGN_WORKSPACE.</p><pre>{\n  "mcpServers": {\n    "inklark": {\n      "command": "node",\n      "args": ["/path/to/fillsign/agent/mcp.mjs"],\n      "env": { "FILLSIGN_WORKSPACE": "/your/document/folder" }\n    }\n  }\n}</pre></details><p class="fine-print">An agent using a cloud model may send document content to its provider. Inklark does not call a model itself.</p>`,
  );
  $("#copy-agent-setup").onclick = () => copyAgentSetup();
}
function privacy() {
  modal(
    "Privacy and security",
    `<p>PDF editing happens on this device. The app uses bundled assets and makes no calls to AI providers. Your existing agent controls which information it sends to its model.</p><p>Saved signatures use AES-GCM encryption with a password-derived key. Your password and unlocked signatures stay in this session. The vault locks after five minutes of inactivity.</p><p>Every signature export requires your approval of a rendered PDF. Agent source labels are claims to check, not independent verification.</p><p>A visual signature can be copied from a finished PDF. Software with unrestricted access to your computer can also access its files or screen. This app does not isolate secrets from a compromised device.</p><p>Browser storage can be cleared. Export an encrypted vault backup. There is no password recovery or automatic device synchronization.</p><p>The app supports standard fillable PDFs and manual text placement on scanned pages. OCR and certificate signing are outside this version. Text export supports Latin characters.</p>`,
  );
}

$("#open").onclick = pick;
$("#choose-pdf").onclick = pick;
$("#file-input").onchange = (e) => action(() => openFile(e.target.files[0]));
$("#sample").onclick = () =>
  action(async () => {
    if (
      s.items.length &&
      !confirm("Open the sample and discard unsaved edits?")
    )
      return;
    await openPdf(await demoPdf(), "sample-contact-form.pdf");
  });
$("#export").onclick = () => action(review);
$("#agent-help").onclick = agentHelp;
$("#privacy").onclick = privacy;
$("#about").onclick = privacy;
$("#mobile-vault").onclick = () => (vault ? vaultManager() : vaultDialog());
for (const button of document.querySelectorAll("[data-tool]"))
  button.onclick = () => setTool(button.dataset.tool);
$("#undo").onclick = () => {
  if (history.length) {
    future.push(snapshot());
    s.items = JSON.parse(history.pop());
    s.selected = null;
    changed();
    renderNativeFields();
  }
};
$("#redo").onclick = () => {
  if (future.length) {
    history.push(snapshot());
    s.items = JSON.parse(future.pop());
    s.selected = null;
    changed();
    renderNativeFields();
  }
};
$("#previous").onclick = () => goPage(s.page - 1);
$("#next").onclick = () => goPage(s.page + 1);
$("#zoom-in").onclick = () => {
  s.scale = Math.min(2.5, s.scale + 0.15);
  action(() => renderPage());
};
$("#zoom-out").onclick = () => {
  s.scale = Math.max(0.25, s.scale - 0.15);
  action(() => renderPage());
};
$("#fit").onclick = () => action(() => renderPage(true));
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (e.dataTransfer.types.includes("Files")) {
    dragDepth++;
    $("#drop-overlay").hidden = false;
  }
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("#drop-overlay").hidden = true;
  }
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#drop-overlay").hidden = true;
  action(() => openFile(e.dataTransfer.files[0]));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $(".details-sidebar").classList.remove("mobile-open");
    s.tool = "cursor";
    updateChrome();
  }
  if (e.target.closest("input,textarea,select,dialog")) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    (e.shiftKey ? $("#redo") : $("#undo")).click();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
    e.preventDefault();
    pick();
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") removeSelected();
  const keys = {
    v: "cursor",
    t: "text",
    c: "check",
    d: "date",
    s: "signature",
  };
  if (!e.ctrlKey && !e.metaKey && keys[e.key.toLowerCase()])
    setTool(keys[e.key.toLowerCase()]);
});
for (const type of ["pointerdown", "keydown"])
  document.addEventListener(type, () => (lastActivity = Date.now()), {
    passive: true,
  });
setInterval(() => {
  if (vault && Date.now() - lastActivity > 5 * 60 * 1000) lockVault();
}, 10000);
window.addEventListener("beforeunload", (e) => {
  if (s.items.length) {
    e.preventDefault();
    e.returnValue = "";
  }
});
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => action(() => renderPage(true)), 250);
});
renderVault();
renderInspector();

// A local request bridge has no signing endpoint. It serves one unsigned packet
// and accepts a completion receipt. Its secret arrives in a URL fragment.
async function loadBridge() {
  const params = new URLSearchParams(location.hash.slice(1)),
    token = params.get("request");
  if (!token) return;
  if (
    s.items.length &&
    !confirm(
      "Open this agent draft? Save your current unsigned draft first if you need its edits.",
    )
  )
    return;
  historyReplace();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw Error("The request link is invalid.");
  if (!["127.0.0.1", "localhost"].includes(location.hostname))
    throw Error("Agent requests must open from the local Inklark server.");
  const response = await fetch("./request", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok)
    throw Error(
      "This signing request expired or was already opened. Ask your agent to create a new one.",
    );
  const packet = await response.json();
  bridge = {
    origin: location.origin,
    token,
    requestHash: packet.document.sha256,
  };
  await openPacket(packet);
}
function historyReplace() {
  window.history.replaceState(null, "", location.pathname + location.search);
}
action(loadBridge);
window.addEventListener("hashchange", () => action(loadBridge));
if (
  "serviceWorker" in navigator &&
  import.meta.env.PROD &&
  !["127.0.0.1", "localhost"].includes(location.hostname)
)
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .catch(() => {});
