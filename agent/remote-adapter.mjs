import { makePacket } from "../src/core.js";
import { makeDelivery, verifyDeliveryTarget } from "../src/delivery.js";
import { randomId } from "../src/trust.js";

// Runs in the existing agent's artifact/runtime environment. The relay never
// receives the plaintext packet. invokeTool is the host's connected MCP caller.
export async function prepareRemoteRequest(
  bytes,
  name,
  items,
  target,
  {
    requestId = randomId(),
    expiresAt = Date.now() + 30 * 60000,
    note = "",
    expectedFingerprint,
  } = {},
) {
  if (!target?.deviceId || !target.deliveryPublicKey)
    throw Error("Connect to a paired signing device first.");
  await verifyDeliveryTarget(target, expectedFingerprint);
  const packet = await makePacket(bytes, name, items, note);
  const route = { version: 1, deviceId: target.deviceId, requestId, expiresAt };
  return makeDelivery(packet, target.deliveryPublicKey, route);
}
export async function deliverRemoteRequest(
  delivery,
  invokeTool,
  { onProgress = () => {} } = {},
) {
  const reservation = await invokeTool("start_signing_request", {
    manifest: delivery.manifest,
  });
  if (reservation.status === "completed") return reservation;
  if (reservation.status === "pending")
    return invokeTool("finish_signing_request", {
      request_id: delivery.manifest.route.requestId,
    });
  if (reservation.status !== "uploading")
    throw Error("This delivery is closed. Prepare a new signing request.");
  for (const [index, ciphertext] of delivery.chunks.entries()) {
    await invokeTool("upload_signing_chunk", {
      request_id: delivery.manifest.route.requestId,
      index,
      ciphertext,
    });
    onProgress({ uploaded: index + 1, total: delivery.chunks.length });
  }
  return invokeTool("finish_signing_request", {
    request_id: delivery.manifest.route.requestId,
  });
}
