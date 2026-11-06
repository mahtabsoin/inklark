import { spawnSync } from "node:child_process";
import { bytesToBase64, base64ToBytes } from "../src/core.js";
import { PDFDocument, StandardFonts } from "pdf-lib";

// A PDF can contain painted answers underneath empty interactive fields.
// Keep this synthetic: real financial forms must never become test fixtures.
export async function paintedAnswerFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Existing sample answer", { x: 64, y: 610, size: 14, font });
  const form = doc.getForm();
  const empty = form.createTextField("painted_answer");
  empty.addToPage(page, {
    x: 56,
    y: 600,
    width: 300,
    height: 32,
    backgroundColor: undefined,
    borderWidth: 0,
  });
  const filled = form.createTextField("saved_answer");
  filled.addToPage(page, { x: 56, y: 500, width: 300, height: 32 });
  filled.setText("Saved sample answer");
  return doc.save();
}
const python =
  process.env.FILLSIGN_PYTHON ||
  (process.platform === "win32" ? "python" : "python3");
export const pdfHelperAvailable =
  spawnSync(python, ["-c", "import pikepdf"], { windowsHide: true }).status ===
  0;
export function encryptedFixture(bytes, password = "") {
  const result = spawnSync(
    python,
    [
      "-c",
      `import pikepdf,io,sys,base64,json
r=json.load(sys.stdin)
p=pikepdf.Pdf.open(io.BytesIO(base64.b64decode(r['base64'])))
o=io.BytesIO()
p.save(o,encryption=pikepdf.Encryption(owner='synthetic-owner-password',user=r['password'],R=6))
print(base64.b64encode(o.getvalue()).decode())`,
    ],
    {
      input: JSON.stringify({ base64: bytesToBase64(bytes), password }),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw Error("Could not generate synthetic protected PDF.");
  return base64ToBytes(result.stdout.trim());
}
