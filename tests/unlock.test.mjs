import test from "node:test";
import assert from "node:assert/strict";
import { demoPdf } from "../src/demo.js";
import {
  loadPdf,
  inspectDocument,
  bytesToBase64,
  base64ToBytes,
} from "../src/core.js";
import { unlockLocalPdf } from "../agent/unlock.mjs";
import {
  encryptedFixture,
  pdfHelperAvailable as available,
} from "./pdf-fixtures.mjs";
test("malformed PDFs are distinguished from encryption", async () => {
  await assert.rejects(
    () => loadPdf(new TextEncoder().encode("not a PDF")),
    (error) =>
      error.code === "UNREADABLE_PDF" && !error.message.includes("encrypted"),
  );
});
test(
  "local compatibility helper refuses digitally signed PDFs",
  { skip: !available },
  async () => {
    const { PDFDocument, PDFName } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    doc.addPage();
    const signature = doc.context.register(
      doc.context.obj({ Type: "Sig", ByteRange: [0, 1, 2, 3] }),
    );
    doc.catalog.set(PDFName.of("SyntheticSignature"), signature);
    const bytes = encryptedFixture(await doc.save());
    assert.equal(
      (await unlockLocalPdf({ base64: bytesToBase64(bytes) })).code,
      "SIGNED_PDF",
    );
  },
);
test(
  "local unlock opens encrypted PDFs without an opening password and preserves native fields",
  { skip: !available },
  async () => {
    const bytes = encryptedFixture(await demoPdf());
    await assert.rejects(
      () => loadPdf(bytes),
      (error) => ["ENCRYPTED_PDF", "UNREADABLE_PDF"].includes(error.code),
    );
    const result = await unlockLocalPdf({ base64: bytesToBase64(bytes) });
    assert.equal(result.ok, true);
    const info = inspectDocument(await loadPdf(base64ToBytes(result.base64)));
    assert.equal(info.fields.length, 3);
  },
);
test(
  "local unlock requires the correct opening password",
  { skip: !available },
  async () => {
    const bytes = encryptedFixture(await demoPdf(), "synthetic-pdf-password"),
      base64 = bytesToBase64(bytes);
    assert.equal((await unlockLocalPdf({ base64 })).code, "PASSWORD_REQUIRED");
    assert.equal(
      (await unlockLocalPdf({ base64, password: "incorrect" })).code,
      "WRONG_PASSWORD",
    );
    assert.equal(
      (await unlockLocalPdf({ base64, password: "synthetic-pdf-password" })).ok,
      true,
    );
  },
);
