import test from "node:test";
import assert from "node:assert/strict";
import { demoPdf } from "../src/demo.js";
import { makePacket } from "../src/core.js";
import { localServer, getStatus, closeSessions } from "../agent/engine.mjs";
test("local handoff excludes secrets from agent results and enforces origin, token, and single use", async () => {
  const packet = await makePacket(await demoPdf(), "sample.pdf", []);
  let browserUrl;
  const session = await localServer(packet, {
    openBrowser: (url) => {
      browserUrl = url;
    },
    timeout: 30,
    port: 0,
  });
  try {
    const token = new URL(browserUrl).hash.slice("#request=".length),
      auth = { Authorization: `Bearer ${token}` };
    assert.ok(token);
    const previewOrigin = session.origin.replace("127.0.0.1", "localhost");
    assert.equal((await fetch(previewOrigin + "/sign.html")).status, 200);
    assert.equal(
      (await fetch(previewOrigin + "/request", { headers: auth })).status,
      403,
    );
    assert.equal((await fetch(previewOrigin + "/setup")).status, 403);
    assert.equal(JSON.stringify(session).includes(token), false);
    assert.equal((await fetch(session.origin + "/request")).status, 403);
    assert.equal(
      (
        await fetch(session.origin + "/pdf/unlock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(session.origin + "/pdf/unlock", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://attacker.example",
            "X-Inklark-Action": "open-editable-copy",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(session.origin + "/request", {
          headers: { ...auth, Origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    const response = await fetch(session.origin + "/request", {
      headers: auth,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).format, "fillsign-request");
    assert.equal(
      (await fetch(session.origin + "/request", { headers: auth })).status,
      403,
    );
    assert.equal(
      (await fetch(session.origin + "/sign", { method: "POST", headers: auth }))
        .status,
      405,
    );
    const body = {
      requestHash: packet.document.sha256,
      outputHash: "a".repeat(64),
      status: "completed",
      signatureCount: 1,
    };
    assert.equal(
      (
        await fetch(session.origin + "/complete", {
          method: "POST",
          headers: auth,
          body: JSON.stringify(body),
        })
      ).status,
      403,
    );
    const finish = await fetch(session.origin + "/complete", {
      method: "POST",
      headers: { ...auth, Origin: session.origin },
      body: JSON.stringify(body),
    });
    assert.equal(finish.status, 200);
    const status = await getStatus(session.sessionId);
    assert.equal(status.status, "completed");
    assert.equal("output_path" in status, false);
    assert.match(status.receipt.notice, /does not independently verify/);
    assert.equal(
      (
        await fetch(session.origin + "/complete", {
          method: "POST",
          headers: { ...auth, Origin: session.origin },
          body: JSON.stringify(body),
        })
      ).status,
      403,
    );
  } finally {
    closeSessions();
  }
});
