import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFTextField,
  PDFCheckBox,
  PDFDropdown,
  PDFRadioGroup,
  PDFOptionList,
  StandardFonts,
  rgb,
  degrees,
  EncryptedPDFError,
} from "pdf-lib";

export const MAX_BYTES = 30 * 1024 * 1024;
export const MAX_PAGES = 100;
export const MAX_ITEMS = 500;
export const APP_VERSION = "0.1.0";
export const cleanName = (name) =>
  String(name || "document")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .slice(0, 140);
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function geometry(page) {
  const box = page.getCropBox();
  if (
    ![box.width, box.height].every(
      (n) => Number.isFinite(n) && n >= 1 && n <= 14400,
    )
  )
    throw Error(
      "This PDF has an unsupported page size. Use pages between 1 and 14,400 PDF points per side.",
    );
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(rotation))
    throw Error("This page uses an unsupported rotation.");
  return {
    ...box,
    rotation,
    displayWidth: rotation % 180 ? box.height : box.width,
    displayHeight: rotation % 180 ? box.width : box.height,
  };
}
export function toPdf(g, x, y) {
  switch (g.rotation) {
    case 90:
      return { x: g.x + y, y: g.y + x };
    case 180:
      return { x: g.x + g.width - x, y: g.y + y };
    case 270:
      return { x: g.x + g.width - y, y: g.y + g.height - x };
    default:
      return { x: g.x + x, y: g.y + g.height - y };
  }
}
export function fromPdf(g, x, y) {
  x -= g.x;
  y -= g.y;
  switch (g.rotation) {
    case 90:
      return { x: y, y: x };
    case 180:
      return { x: g.width - x, y };
    case 270:
      return { x: g.height - y, y: g.width - x };
    default:
      return { x, y: g.height - y };
  }
}
export async function loadPdf(bytes) {
  if (!bytes?.length || bytes.length > MAX_BYTES)
    throw Error("Choose a PDF smaller than 30 MB.");
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (cause) {
    const error = new Error(
      cause instanceof EncryptedPDFError
        ? "This PDF uses encryption. Open an editable copy using the local app."
        : "This file could not be read as a PDF. Try saving a fresh PDF copy from its original app.",
    );
    error.code =
      cause instanceof EncryptedPDFError ? "ENCRYPTED_PDF" : "UNREADABLE_PDF";
    throw error;
  }
  if (doc.getPageCount() > MAX_PAGES)
    throw Error("Open a PDF with 100 pages or fewer.");
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (
      obj instanceof PDFDict &&
      (obj.has(PDFName.of("ByteRange")) ||
        obj.get(PDFName.of("Type"))?.toString() === "/Sig")
    ) {
      throw Error(
        "This PDF already contains a digital signature. Editing could invalidate it. Use the unsigned original.",
      );
    }
  }
  if (doc.catalog.get(PDFName.of("Perms")))
    throw Error(
      "This PDF has certification restrictions. Use an unrestricted original.",
    );
  const form = doc.getForm();
  if (form.hasXFA())
    throw Error(
      "This PDF uses an XFA form. Export a standard PDF copy before opening it.",
    );
  return doc;
}
export function inspectDocument(doc) {
  const pages = doc.getPages().map((p) => geometry(p));
  const fields = [];
  for (const field of doc.getForm().getFields()) {
    const type =
      field instanceof PDFTextField
        ? "PDFTextField"
        : field instanceof PDFCheckBox
          ? "PDFCheckBox"
          : field instanceof PDFDropdown
            ? "PDFDropdown"
            : field instanceof PDFRadioGroup
              ? "PDFRadioGroup"
              : field instanceof PDFOptionList
                ? "PDFOptionList"
                : "";
    if (
      ![
        "PDFTextField",
        "PDFCheckBox",
        "PDFDropdown",
        "PDFRadioGroup",
        "PDFOptionList",
      ].includes(type) ||
      field.isReadOnly()
    )
      continue;
    let value = "";
    if (type === "PDFTextField") value = field.getText() || "";
    else if (type === "PDFCheckBox") value = field.isChecked();
    else if (type === "PDFRadioGroup") value = field.getSelected() || "";
    else value = field.getSelected()[0] || "";
    for (const widget of field.acroField.getWidgets()) {
      const pageRef = widget.P();
      let pageIndex = doc
        .getPages()
        .findIndex(
          (p) =>
            p.ref === pageRef ||
            (pageRef && p.ref.toString() === pageRef.toString()),
        );
      if (pageIndex < 0)
        pageIndex = doc
          .getPages()
          .findIndex((p) =>
            (p.node.Annots()?.asArray() || []).some(
              (ref) => doc.context.lookup(ref) === widget.dict,
            ),
          );
      if (pageIndex < 0) continue;
      const rect = widget.getRectangle(),
        g = pages[pageIndex];
      const a = fromPdf(g, rect.x, rect.y),
        b = fromPdf(g, rect.x + rect.width, rect.y + rect.height);
      fields.push({
        name: field.getName(),
        type,
        page: pageIndex + 1,
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(a.x - b.x),
        height: Math.abs(a.y - b.y),
        value,
        options:
          typeof field.getOptions === "function" ? field.getOptions() : [],
        required: field.isRequired(),
        multiline: field instanceof PDFTextField && field.isMultiline(),
      });
    }
  }
  return { pages, fields };
}
function finite(n, min, max, label) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max)
    throw Error(`Invalid ${label}.`);
  return n;
}
export function validateItems(items, info) {
  if (!Array.isArray(items) || items.length > MAX_ITEMS)
    throw Error("A request can contain up to 500 fields.");
  const ids = new Set();
  return items.map((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      !["text", "check", "signature", "field"].includes(item.type)
    )
      throw Error(`Unsupported field ${index + 1}.`);
    if (item.image || item.dataUrl || item.signature || item.privateKey)
      throw Error(
        "Agent requests can mark signature locations only. Signature assets belong in the human vault.",
      );
    const page = finite(item.page, 1, info.pages.length, "page");
    if (!Number.isInteger(page))
      throw Error("Page numbers must be whole numbers.");
    const g = info.pages[page - 1];
    const id = String(item.id || `item-${index + 1}`).slice(0, 100);
    if (ids.has(id)) throw Error("Field IDs must be unique.");
    ids.add(id);
    const out = {
      id,
      type: item.type,
      page,
      x: finite(item.x, 0, g.displayWidth, "horizontal position"),
      y: finite(item.y, 0, g.displayHeight, "vertical position"),
      width: finite(item.width, 3, g.displayWidth, "width"),
      height: finite(item.height, 3, g.displayHeight, "height"),
      value:
        item.type === "check"
          ? !!item.value
          : String(item.value ?? "").slice(0, 2000),
      label: String(
        item.label || (item.type === "signature" ? "Signature" : "Field"),
      ).slice(0, 200),
      source: String(item.source || "").slice(0, 1000),
      needsReview: !!item.needsReview || !!item.sensitive || !!item.question,
      sensitive: !!item.sensitive,
      question: String(item.question || "").slice(0, 1000),
      fontSize: finite(item.fontSize ?? 12, 6, 72, "font size"),
      color: /^#[0-9a-f]{6}$/i.test(item.color || "") ? item.color : "#20332f",
    };
    if (
      out.x + out.width > g.displayWidth + 0.1 ||
      out.y + out.height > g.displayHeight + 0.1
    )
      throw Error(`Field ${index + 1} extends beyond the page.`);
    if (item.type === "field") {
      const field = info.fields.find(
        (f) => f.name === item.fieldName && f.page === page,
      );
      if (!field)
        throw Error(
          "The request refers to a missing or unsupported PDF form field.",
        );
      out.fieldName = field.name;
      out.value = field.type === "PDFCheckBox" ? !!item.value : out.value;
      if (
        ["PDFDropdown", "PDFRadioGroup", "PDFOptionList"].includes(
          field.type,
        ) &&
        out.value &&
        !field.options.includes(out.value)
      )
        throw Error("Choose an available form option.");
    }
    return out;
  });
}
export async function makePacket(bytes, filename, items, note = "") {
  const info = inspectDocument(await loadPdf(bytes));
  const safe = validateItems(items, info);
  return {
    format: "fillsign-request",
    version: 1,
    document: {
      name: cleanName(filename),
      sha256: await sha256(bytes),
      base64: bytesToBase64(bytes),
    },
    items: safe,
    note: String(note).slice(0, 2000),
  };
}
export async function readPacket(packet) {
  if (!packet || packet.format !== "fillsign-request" || packet.version !== 1)
    throw Error("Choose an Inklark agent request file.");
  const bytes = base64ToBytes(packet.document?.base64 || "");
  if ((await sha256(bytes)) !== packet.document?.sha256)
    throw Error(
      "The PDF does not match this request. Ask your agent to prepare it again.",
    );
  const doc = await loadPdf(bytes),
    info = inspectDocument(doc);
  return {
    bytes,
    info,
    name: cleanName(packet.document.name),
    items: validateItems(packet.items, info),
    note: String(packet.note || "").slice(0, 2000),
    hash: packet.document.sha256,
  };
}
export function bytesToBase64(bytes) {
  let str = "";
  for (let i = 0; i < bytes.length; i += 32768)
    str += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(str);
}
export function base64ToBytes(str) {
  if (
    typeof str !== "string" ||
    str.length > MAX_BYTES * 1.4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(str)
  )
    throw Error("The embedded PDF is invalid or too large.");
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}
function color(value) {
  return rgb(
    ...[1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255),
  );
}
export async function exportPdf(
  bytes,
  items,
  { signatures = new Map(), flatten = true } = {},
) {
  const doc = await loadPdf(bytes),
    info = inspectDocument(doc),
    safe = validateItems(items, info);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const item of safe) {
    const page = doc.getPage(item.page - 1),
      g = info.pages[item.page - 1];
    if (item.type === "field") {
      const field = doc.getForm().getField(item.fieldName);
      if (field instanceof PDFTextField) {
        field.setText(item.value);
        field.setFontSize(item.fontSize);
      } else if (field instanceof PDFCheckBox)
        item.value ? field.check() : field.uncheck();
      else if (item.value) field.select(item.value);
      else if (typeof field.clear === "function") field.clear();
      continue;
    }
    if (item.type === "signature") {
      const png = signatures.get(item.id);
      if (!png) continue;
      const image = await doc.embedPng(png);
      page.drawImage(image, {
        ...toPdf(g, item.x, item.y + item.height),
        width: item.width,
        height: item.height,
        rotate: degrees(g.rotation),
      });
      continue;
    }
    if (item.type === "check") {
      if (!item.value) continue;
      const p1 = toPdf(
        g,
        item.x + item.width * 0.15,
        item.y + item.height * 0.5,
      );
      const p2 = toPdf(
        g,
        item.x + item.width * 0.4,
        item.y + item.height * 0.8,
      );
      const p3 = toPdf(
        g,
        item.x + item.width * 0.9,
        item.y + item.height * 0.15,
      );
      page.drawLine({
        start: p1,
        end: p2,
        thickness: 1.6,
        color: color(item.color),
      });
      page.drawLine({
        start: p2,
        end: p3,
        thickness: 1.6,
        color: color(item.color),
      });
      continue;
    }
    try {
      const lines = item.value.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if ((i + 1) * item.fontSize * 1.2 > item.height + item.fontSize * 0.3)
          throw Error(
            "Text is taller than its field. Enlarge the box or reduce the font size.",
          );
        if (font.widthOfTextAtSize(lines[i], item.fontSize) > item.width + 1)
          throw Error(
            "Text is wider than its field. Enlarge the box or reduce the font size.",
          );
        page.drawText(lines[i], {
          ...toPdf(
            g,
            item.x,
            item.y + item.fontSize * 0.82 + i * item.fontSize * 1.2,
          ),
          size: item.fontSize,
          font,
          color: color(item.color),
          rotate: degrees(g.rotation),
        });
      }
    } catch (e) {
      if (/encode/.test(e.message))
        throw Error(
          "This version supports Latin text. A field contains an unsupported character.",
        );
      throw e;
    }
  }
  try {
    const form = doc.getForm();
    form.updateFieldAppearances(font);
    if (flatten && form.getFields().length) {
      // pdf-lib can leave page references to deleted radio-group widgets.
      // Capture each field's annotations before flattening deletes its objects.
      const widgets = new Set(
        form
          .getFields()
          .flatMap((field) =>
            field.acroField.getWidgets().map((widget) => widget.dict),
          ),
      );
      const removals = doc
        .getPages()
        .map(
          (page) =>
            new Set(
              (page.node.Annots()?.asArray() || []).filter((ref) =>
                widgets.has(doc.context.lookup(ref)),
              ),
            ),
        );
      form.flatten({ updateFieldAppearances: false });
      for (const [index, page] of doc.getPages().entries()) {
        const annotations = page.node.Annots();
        if (!annotations) continue;
        for (let n = annotations.size() - 1; n >= 0; n--)
          if (removals[index].has(annotations.get(n))) annotations.remove(n);
        if (!annotations.size()) page.node.delete(PDFName.of("Annots"));
      }
    }
  } catch {
    throw Error(
      "A form value could not be saved. Check its characters and available options.",
    );
  }
  return doc.save({ updateFieldAppearances: false });
}
