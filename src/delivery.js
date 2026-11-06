import {
  MAX_DELIVERY_BYTES,
  sealRequest,
  fingerprint,
  digest,
  utf8,
  unbase64url,
  openRequest,
} from "./trust.js";

export const CHUNK_CHARS = 256 * 1024;
export async function deliveryFingerprint(target) {
  return fingerprint({
    deviceId: target.deviceId,
    signerName: target.signerName,
    deliveryPublicKey: target.deliveryPublicKey,
    appearanceRevision: target.appearanceRevision,
  });
}
export async function verifyDeliveryTarget(target, expectedFingerprint) {
  if (
    !hash(expectedFingerprint) ||
    (await deliveryFingerprint(target)) !== expectedFingerprint
  )
    throw Error(
      "The signing device does not match the human's pairing fingerprint. Do not upload this document.",
    );
}
const hash = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
function exact(object, keys) {
  return (
    object &&
    typeof object === "object" &&
    !Array.isArray(object) &&
    Object.keys(object).sort().join(",") === keys.split(",").sort().join(",")
  );
}
export async function makeDelivery(payload, publicKey, route) {
  const envelope = await sealRequest(payload, publicKey, route),
    chunks = [];
  for (let i = 0; i < envelope.ciphertext.length; i += CHUNK_CHARS)
    chunks.push(envelope.ciphertext.slice(i, i + CHUNK_CHARS));
  const manifest = {
    route: envelope.route,
    ephemeralKey: envelope.ephemeralKey,
    salt: envelope.salt,
    iv: envelope.iv,
    chunks: await Promise.all(
      chunks.map(async (data) => ({
        length: data.length,
        hash: await digest(utf8(data)),
      })),
    ),
  };
  return { manifest, chunks, deliveryHash: await fingerprint(manifest) };
}
export async function validateManifest(manifest, now = Date.now()) {
  if (
    !exact(manifest, "route,ephemeralKey,salt,iv,chunks") ||
    !exact(manifest.route, "version,deviceId,requestId,expiresAt")
  )
    throw Error("Invalid delivery manifest.");
  const r = manifest.route;
  if (
    r.version !== 1 ||
    !hash(r.deviceId) ||
    !hash(r.requestId) ||
    !Number.isSafeInteger(r.expiresAt) ||
    r.expiresAt <= now ||
    r.expiresAt > now + 30 * 60000
  )
    throw Error("The delivery is invalid or expired.");
  const key = manifest.ephemeralKey;
  if (
    !key ||
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    key.d ||
    Object.keys(key).some(
      (k) => !["kty", "crv", "x", "y", "ext", "key_ops"].includes(k),
    )
  )
    throw Error("Invalid encryption public key.");
  await crypto.subtle.importKey(
    "jwk",
    key,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  if (
    unbase64url(manifest.salt, 32).length !== 32 ||
    unbase64url(manifest.iv, 12).length !== 12 ||
    !Array.isArray(manifest.chunks) ||
    !manifest.chunks.length ||
    manifest.chunks.length > 256
  )
    throw Error("Invalid encrypted delivery.");
  let length = 0;
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (
      !exact(chunk, "length,hash") ||
      !hash(chunk.hash) ||
      !Number.isSafeInteger(chunk.length) ||
      chunk.length < 1 ||
      chunk.length > CHUNK_CHARS ||
      (index < manifest.chunks.length - 1 && chunk.length !== CHUNK_CHARS)
    )
      throw Error("Invalid delivery chunk.");
    length += chunk.length;
  }
  if (length > Math.ceil(((MAX_DELIVERY_BYTES + 16) * 4) / 3))
    throw Error("The encrypted request exceeds the delivery limit.");
  return manifest;
}
export async function verifyChunk(manifest, index, data) {
  const expected = manifest.chunks[index];
  if (
    !Number.isInteger(index) ||
    !expected ||
    typeof data !== "string" ||
    data.length !== expected.length ||
    !/^[A-Za-z0-9_-]+$/.test(data) ||
    (await digest(utf8(data))) !== expected.hash
  )
    throw Error("The encrypted chunk does not match the manifest.");
}
export async function openDelivery(manifest, chunks, privateKey, deviceId) {
  await validateManifest(manifest);
  if (chunks.length !== manifest.chunks.length)
    throw Error("The delivery is incomplete.");
  for (const [index, data] of chunks.entries())
    await verifyChunk(manifest, index, data);
  return openRequest(
    { ...manifest, ciphertext: chunks.join("") },
    privateKey,
    deviceId,
  );
}
