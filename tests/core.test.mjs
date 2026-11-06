import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName, degrees } from "pdf-lib";
import { demoPdf } from "../src/demo.js";
import {
  loadPdf,
  inspectDocument,
  validateItems,
  makePacket,
  readPacket,
  exportPdf,
  geometry,
  toPdf,
  fromPdf,
} from "../src/core.js";
const text = {
  id: "name",
  type: "text",
  page: 1,
  x: 50,
  y: 50,
  width: 200,
  height: 30,
  value: "Jane Example",
  fontSize: 12,
};
test("agent packet binds the draft to its exact original PDF and rejects signature assets", async () => {
  const bytes = await demoPdf(),
    packet = await makePacket(bytes, "form.pdf", [text]);
  assert.equal((await readPacket(packet)).items[0].value, "Jane Example");
  packet.document.sha256 = "0".repeat(64);
  await assert.rejects(() => readPacket(packet), /does not match/);
  await assert.rejects(
    () =>
      makePacket(bytes, "form.pdf", [
        { ...text, type: "signature", dataUrl: "data:image/png;base64,AA==" },
      ]),
    /Signature assets/,
  );
});
test("sensitive and uncertain answers cannot arrive marked as reviewed", async () => {
  const info = inspectDocument(await loadPdf(await demoPdf()));
  const [item] = validateItems(
    [{ ...text, sensitive: true, needsReview: false, confirmed: true }],
    info,
  );
  assert.equal(item.needsReview, true);
  assert.equal("confirmed" in item, false);
  assert.throws(() => validateItems([{ ...text, x: -1 }], info), /Invalid/);
  assert.throws(() => validateItems([{ ...text, x: 600 }], info), /beyond/);
  assert.throws(() => validateItems([text, text], info), /unique/);
});
test("native form fields are filled and flattened into a readable PDF", async () => {
  const bytes = await demoPdf(),
    info = inspectDocument(await loadPdf(bytes));
  const field = info.fields.find((f) => f.name === "full_name");
  assert.ok(field);
  const output = await exportPdf(bytes, [
    {
      ...field,
      id: "f",
      type: "field",
      fieldName: "full_name",
      value: "Jane Example",
    },
  ]);
  const doc = await PDFDocument.load(output);
  assert.equal(doc.getForm().getFields().length, 0);
  assert.equal(doc.getPageCount(), 1);
});
test("existing digital signatures and certification restrictions are rejected", async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.context.register(
    doc.context.obj({ Type: "Sig", ByteRange: [0, 1, 2, 3] }),
  );
  await assert.rejects(() => loadPdfFrom(doc), /digital signature/);
  const restricted = await PDFDocument.create();
  restricted.addPage();
  restricted.catalog.set(PDFName.of("Perms"), restricted.context.obj({}));
  await assert.rejects(() => loadPdfFrom(restricted), /certification/);
});
async function loadPdfFrom(doc) {
  return loadPdf(await doc.save());
}
test("placement transforms round trip on rotated and cropped pages", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  page.setCropBox(20, 30, 500, 700);
  for (const rotation of [0, 90, 180, 270]) {
    page.setRotation(degrees(rotation));
    const g = geometry(page),
      p = toPdf(g, 47, 91),
      result = fromPdf(g, p.x, p.y);
    assert.deepEqual(result, { x: 47, y: 91 });
  }
});
test("overflowing and unsupported text fails instead of silently disappearing", async () => {
  const bytes = await demoPdf();
  await assert.rejects(
    () =>
      exportPdf(bytes, [{ ...text, width: 10, value: "This will not fit" }]),
    /wider/,
  );
  await assert.rejects(
    () => exportPdf(bytes, [{ ...text, value: "漢字" }]),
    /unsupported character/,
  );
});
