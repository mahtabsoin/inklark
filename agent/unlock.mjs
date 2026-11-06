import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MAX_BYTES, base64ToBytes } from "../src/core.js";
export async function unlockLocalPdf(input) {
  if (
    typeof input?.base64 !== "string" ||
    input.base64.length > MAX_BYTES * 1.4 ||
    typeof (input.password ?? "") !== "string" ||
    (input.password || "").length > 1000
  )
    throw Error("Invalid PDF unlock request.");
  const executable =
    process.env.FILLSIGN_PYTHON ||
    (process.platform === "win32" ? "python" : "python3");
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [fileURLToPath(new URL("./unlock.py", import.meta.url))],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    let output = "",
      length = 0,
      finished = false;
    const end = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const unavailable = () =>
      end(null, {
        ok: false,
        code: "HELPER_UNAVAILABLE",
        message:
          "Local PDF support is not installed. Ask your agent to install requirements-pdf.txt.",
      });
    const timer = setTimeout(() => {
      child.kill();
      end(null, {
        ok: false,
        code: "TIMEOUT",
        message:
          "Opening this PDF took too long. Try a smaller or freshly saved copy.",
      });
    }, 45000);
    child.on("error", unavailable);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_BYTES * 1.5) {
        child.kill();
        end(Error("The editable PDF is too large."));
        return;
      }
      output += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (code !== 0) {
        unavailable();
        return;
      }
      try {
        const value = JSON.parse(output);
        if (value.ok) base64ToBytes(value.base64);
        end(null, value);
      } catch {
        end(Error("Local PDF support returned an unreadable result."));
      }
    });
    child.stdin.end(
      JSON.stringify({ base64: input.base64, password: input.password || "" }),
    );
  });
}
