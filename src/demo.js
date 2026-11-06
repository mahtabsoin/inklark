import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
export async function demoPdf() {
  const doc = await PDFDocument.create();
  const p = doc.addPage([612, 792]),
    font = await doc.embedFont(StandardFonts.Helvetica),
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const dark = rgb(0.12, 0.25, 0.22),
    gray = rgb(0.42, 0.47, 0.46);
  p.drawText("Sample contact form", {
    x: 56,
    y: 714,
    size: 25,
    font: bold,
    color: dark,
  });
  p.drawText("Try filling a field, adding text, or placing a signature.", {
    x: 56,
    y: 686,
    size: 11,
    font,
    color: gray,
  });
  p.drawLine({
    start: { x: 56, y: 662 },
    end: { x: 556, y: 662 },
    thickness: 1,
    color: rgb(0.82, 0.86, 0.84),
  });
  const form = doc.getForm();
  for (const [name, label, y] of [
    ["full_name", "Full name", 606],
    ["email", "Email address", 524],
    ["notes", "Notes", 442],
  ]) {
    p.drawText(label, {
      x: 56,
      y: y + (name === "notes" ? 70 : 38),
      size: 11,
      font: bold,
      color: dark,
    });
    const field = form.createTextField(name);
    field.addToPage(p, {
      x: 56,
      y,
      width: 500,
      height: name === "notes" ? 60 : 28,
      borderWidth: 0.5,
      borderColor: rgb(0.7, 0.77, 0.74),
      backgroundColor: rgb(1, 1, 1),
    });
    if (name === "notes") field.enableMultiline();
  }
  p.drawText("Signature", { x: 56, y: 300, size: 11, font: bold, color: dark });
  p.drawLine({
    start: { x: 56, y: 238 },
    end: { x: 310, y: 238 },
    thickness: 0.7,
    color: gray,
  });
  p.drawText("Date", { x: 370, y: 300, size: 11, font: bold, color: dark });
  p.drawLine({
    start: { x: 370, y: 238 },
    end: { x: 556, y: 238 },
    thickness: 0.7,
    color: gray,
  });
  p.drawText("This sample is for trying Inklark. It is not an agreement.", {
    x: 56,
    y: 104,
    size: 10,
    font,
    color: gray,
  });
  return doc.save();
}
