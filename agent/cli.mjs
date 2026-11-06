#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  inspectPdf,
  packetFor,
  localServer,
  getStatus,
  closeSessions,
  allowedPath,
  writePacketFile,
  renderPreview,
} from "./engine.mjs";
const args = process.argv.slice(2),
  command = args[0];
const arg = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
async function plan() {
  const file = arg("--plan");
  if (!file)
    throw Error("Provide --plan plan.json. See docs/AGENT.md for the schema.");
  const raw = await readFile(await allowedPath(file), "utf8");
  if (raw.length > 1024 * 1024) throw Error("The plan is too large.");
  const value = JSON.parse(raw);
  return Array.isArray(value) ? { items: value } : value;
}
try {
  if (command === "inspect")
    console.log(
      JSON.stringify(
        await inspectPdf(
          args[1],
          arg("--page") ? Number(arg("--page")) : undefined,
        ),
        null,
        2,
      ),
    );
  else if (command === "packet") {
    const p = await plan();
    console.log(
      JSON.stringify(
        await writePacketFile(args[1], p.items, p.note, arg("--output")),
        null,
        2,
      ),
    );
  } else if (command === "preview") {
    const p = await plan();
    const result = await renderPreview(
      args[1],
      p.items,
      Number(arg("--page") || 1),
    );
    const output = arg("--output");
    if (!output)
      throw Error("Provide --output preview.png inside your workspace.");
    const root = await allowedPath("."),
      parent = await allowedPath(path.dirname(output));
    const relative = path.relative(root, parent);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !output.endsWith(".png")
    )
      throw Error("Choose a .png path inside the workspace.");
    await writeFile(path.join(parent, path.basename(output)), result.png, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        path: output,
        signatureLocations: result.signatureLocations,
      }),
    );
  } else if (command === "request") {
    const p = await plan();
    const request = await localServer(
      await packetFor(args[1], p.items, p.note),
    );
    console.log(JSON.stringify(request, null, 2));
    const timer = setInterval(async () => {
      try {
        const result = await getStatus(request.sessionId);
        if (result.status !== "pending") {
          console.log(JSON.stringify(result, null, 2));
          clearInterval(timer);
          closeSessions();
        }
      } catch (e) {
        console.error(e.message);
        clearInterval(timer);
        closeSessions();
      }
    }, 1000);
  } else if (command === "serve") {
    console.log(JSON.stringify(await localServer(null), null, 2));
  } else
    console.log(
      "Inklark\n\n  npm run build\n  npm start\n\n  node agent/cli.mjs inspect document.pdf\n  node agent/cli.mjs preview document.pdf --plan plan.json --page 1 --output preview.png\n  node agent/cli.mjs request document.pdf --plan plan.json\n  node agent/cli.mjs packet document.pdf --plan plan.json --output draft.fillsign.json\n\nPaths are restricted to FILLSIGN_WORKSPACE (default: current directory).\nAgents prepare drafts. The human approves signing in the browser.",
    );
} catch (e) {
  console.error(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
  closeSessions();
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    closeSessions();
    process.exit(0);
  });
