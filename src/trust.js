// Shared browser/relay primitives. Crypto operations use Web Crypto, never a
// signature image. This module deliberately supports ES256 credentials only.
const encoder = new TextEncoder();
export const utf8 = (value) => encoder.encode(value);
export function base64url(value) {
  let text = "";
  const bytes = new Uint8Array(value);
  for (let n = 0; n < bytes.length; n += 32768)
    text += String.fromCharCode(...bytes.subarray(n, n + 32768));
  return btoa(text)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function unbase64url(text, max = 32 * 1024 * 1024) {
  if (
    typeof text !== "string" ||
    text.length > Math.ceil((max * 4) / 3) ||
    !/^[A-Za-z0-9_-]*$/.test(text)
  )
    throw Error("Invalid encoded data.");
  const result = Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (result.length > max || base64url(result) !== text)
    throw Error("Invalid encoded data.");
  return result;
}
export const randomId = () =>
  base64url(crypto.getRandomValues(new Uint8Array(32)));
export async function digest(bytes) {
  return base64url(await crypto.subtle.digest("SHA-256", bytes));
}
export function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  throw Error("The approval contains unsupported data.");
}
export const fingerprint = (value) => digest(utf8(canonical(value)));
export async function createDeliveryKey() {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}
export async function publicDeliveryKey(key) {
  return crypto.subtle.exportKey("jwk", key);
}
async function deliveryCipher(privateKey, publicJwk, salt) {
  if (publicJwk.kty !== "EC" || publicJwk.crv !== "P-256" || publicJwk.d)
    throw Error("Invalid recipient key.");
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const secret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256,
  );
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8("inklark-delivery-v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
function validateRoute(route, now = Date.now()) {
  if (
    !route ||
    route.version !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(route.deviceId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(route.requestId) ||
    !Number.isSafeInteger(route.expiresAt) ||
    route.expiresAt <= now ||
    route.expiresAt > now + 30 * 60 * 1000
  )
    throw Error("This delivery is invalid or expired.");
  if (
    Object.keys(route).sort().join(",") !==
    "deviceId,expiresAt,requestId,version"
  )
    throw Error("Unexpected delivery metadata.");
}
export async function sealRequest(payload, recipient, route) {
  validateRoute(route);
  const pair = await createDeliveryKey();
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deliveryCipher(pair.privateKey, recipient, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(canonical(route)) },
    key,
    utf8(canonical(payload)),
  );
  return {
    route,
    ephemeralKey: await publicDeliveryKey(pair.publicKey),
    salt: base64url(salt),
    iv: base64url(iv),
    ciphertext: base64url(ciphertext),
  };
}
export async function openRequest(envelope, privateKey, expectedDeviceId) {
  validateRoute(envelope.route);
  if (envelope.route.deviceId !== expectedDeviceId)
    throw Error("This request belongs to another device.");
  const salt = unbase64url(envelope.salt, 32),
    iv = unbase64url(envelope.iv, 12);
  if (salt.length !== 32 || iv.length !== 12)
    throw Error("Invalid encrypted request.");
  const key = await deliveryCipher(privateKey, envelope.ephemeralKey, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: utf8(canonical(envelope.route)) },
    key,
    unbase64url(envelope.ciphertext),
  );
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
  );
}

// WebAuthn authenticators emit ASN.1 DER ECDSA signatures; SubtleCrypto uses
// fixed-width r || s. Accept only canonical P-256 encodings, without truncation.
export function es256Signature(der) {
  if (
    !(der instanceof Uint8Array) ||
    der.length < 8 ||
    der.length > 72 ||
    der[0] !== 0x30 ||
    der[1] !== der.length - 2
  )
    throw Error("Invalid ES256 signature.");
  let offset = 2;
  const output = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (der[offset++] !== 2) throw Error("Invalid ES256 integer.");
    const size = der[offset++];
    if (
      !size ||
      size > 33 ||
      offset + size > der.length ||
      der[offset] & 0x80 ||
      (size > 1 && der[offset] === 0 && !(der[offset + 1] & 0x80))
    )
      throw Error("Invalid ES256 integer.");
    const number = der.subarray(offset + (size === 33 ? 1 : 0), offset + size);
    if (size === 33 && der[offset] !== 0) throw Error("Invalid ES256 integer.");
    output.set(number, part * 32 + 32 - number.length);
    offset += size;
  }
  if (offset !== der.length) throw Error("Invalid ES256 signature length.");
  return output;
}
export async function verifyApproval(assertion, credential, expected) {
  if (
    !expected ||
    !/^[A-Za-z0-9_-]{43}$/.test(expected.challenge) ||
    !Number.isSafeInteger(expected.expiresAt) ||
    expected.expiresAt > Date.now() + 30 * 60 * 1000 ||
    expected.expiresAt <= Date.now()
  )
    throw Error("This approval expired.");
  if (
    assertion.type !== "public-key" ||
    assertion.id !== credential.id ||
    assertion.rawId !== credential.id
  )
    throw Error("The signer credential does not match.");
  const response = assertion.response;
  const clientBytes = unbase64url(response.clientDataJSON, 16384);
  const client = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(clientBytes),
  );
  const origin = new URL(expected.origin);
  if (
    origin.origin !== expected.origin ||
    (origin.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(origin.hostname)) ||
    expected.rpId !== origin.hostname
  )
    throw Error("Unsupported approval origin.");
  if (
    client.type !== "webauthn.get" ||
    client.challenge !== expected.challenge ||
    client.origin !== expected.origin ||
    (client.crossOrigin !== undefined && client.crossOrigin !== false) ||
    client.topOrigin
  )
    throw Error("The approval is for another operation or origin.");
  if (
    response.userHandle != null &&
    response.userHandle !== credential.userHandle
  )
    throw Error("The signer handle does not match.");
  const data = unbase64url(response.authenticatorData, 4096);
  if (
    data.length < 37 ||
    base64url(data.subarray(0, 32)) !== (await digest(utf8(expected.rpId)))
  )
    throw Error("The relying party does not match.");
  const flags = data[32];
  if (
    (flags & 5) !== 5 ||
    flags & 0x40 ||
    (flags & 0x10 && !(flags & 8)) ||
    (credential.backupEligible != null &&
      !!(flags & 8) !== credential.backupEligible)
  )
    throw Error("User presence and verification are required.");
  const counter = new DataView(data.buffer, data.byteOffset + 33, 4).getUint32(
    0,
  );
  if ((counter || credential.counter) && counter <= credential.counter)
    throw Error("This authenticator response was already used.");
  const key = await crypto.subtle.importKey(
    "spki",
    unbase64url(credential.publicKey, 1024),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const clientHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", clientBytes),
  );
  const signed = new Uint8Array(data.length + clientHash.length);
  signed.set(data);
  signed.set(clientHash, data.length);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    es256Signature(unbase64url(response.signature, 72)),
    signed,
  );
  if (!valid) throw Error("The approval signature is invalid.");
  return { counter, backupEligible: !!(flags & 8) };
}

export async function approvalChallenge(intent) {
  return fingerprint({ purpose: "inklark-approve-v1", intent });
}
