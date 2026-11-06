import {
  randomId,
  base64url,
  unbase64url,
  createDeliveryKey,
  publicDeliveryKey,
  digest,
  utf8,
  fingerprint,
  canonical,
  verifyApproval,
  approvalChallenge,
} from "./trust.js";

const DB = "inklark-device-v1";
const KEY = "active-device";
function database() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("device");
      open.result.createObjectStore("approvals", { keyPath: "nonce" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () =>
      reject(
        Error(
          "Device storage is unavailable. Use a normal browser window with storage enabled.",
        ),
      );
  });
}
async function transaction(storeName, mode, run) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = run(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(request?.result);
      tx.onabort = tx.onerror = () =>
        reject(
          Error("The device operation was interrupted or already completed."),
        );
    });
  } finally {
    db.close();
  }
}
export const getDevice = () =>
  transaction("device", "readonly", (s) => s.get(KEY));
async function saveDevice(profile) {
  await transaction("device", "readwrite", (s) => s.put(profile, KEY));
}
export function deviceSupported() {
  return !!(
    globalThis.isSecureContext &&
    globalThis.PublicKeyCredential &&
    navigator.credentials &&
    globalThis.indexedDB
  );
}
export function assertionJSON(credential) {
  return {
    id: credential.id,
    rawId: base64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: base64url(credential.response.clientDataJSON),
      authenticatorData: base64url(credential.response.authenticatorData),
      signature: base64url(credential.response.signature),
      userHandle: credential.response.userHandle
        ? base64url(credential.response.userHandle)
        : null,
    },
  };
}
async function authenticate(profile, challenge, expiresAt) {
  const result = await navigator.credentials.get({
    publicKey: {
      challenge: unbase64url(challenge),
      rpId: location.hostname,
      allowCredentials: [
        { id: unbase64url(profile.credential.id), type: "public-key" },
      ],
      userVerification: "required",
      timeout: 60000,
    },
  });
  if (!result) throw Error("Authentication was canceled. Nothing was signed.");
  const assertion = assertionJSON(result);
  const verified = await verifyApproval(assertion, profile.credential, {
    challenge,
    expiresAt,
    origin: location.origin,
    rpId: location.hostname,
  });
  return { assertion, verified };
}
export async function enrollDevice(name) {
  if (!deviceSupported())
    throw Error(
      "Open Inklark in a browser with device authentication and HTTPS support.",
    );
  if (await getDevice())
    throw Error("This device already has a signing profile.");
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80)
    throw Error("Enter the name you intend to use when signing.");
  const userHandle = randomId(),
    deviceId = randomId();
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: unbase64url(randomId()),
      rp: { id: location.hostname, name: "Inklark" },
      user: {
        id: unbase64url(userHandle),
        name: name.trim(),
        displayName: name.trim(),
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      attestation: "none",
      timeout: 60000,
    },
  });
  const publicKey = credential?.response.getPublicKey?.();
  if (!publicKey || credential.response.getPublicKeyAlgorithm?.() !== -7)
    throw Error(
      "This authenticator does not provide a supported ES256 credential. Nothing was enrolled.",
    );
  const authData = new Uint8Array(credential.response.getAuthenticatorData());
  if (
    authData.length < 37 ||
    (authData[32] & 5) !== 5 ||
    base64url(authData.subarray(0, 32)) !==
      (await digest(utf8(location.hostname)))
  )
    throw Error("Device registration did not verify user presence.");
  const delivery = await createDeliveryKey();
  const profile = {
    version: 1,
    deviceId,
    name: name.trim(),
    appearanceRevision: randomId(),
    credential: {
      id: credential.id,
      publicKey: base64url(publicKey),
      userHandle,
      counter: 0,
      backupEligible: !!(authData[32] & 8),
    },
    deliveryPrivateKey: delivery.privateKey,
    deliveryPublicKey: await publicDeliveryKey(delivery.publicKey),
  };
  // Registration is un-attested. Require proof of possession of the returned
  // key before saving it, instead of trusting a client-supplied public key.
  const enrollmentChallenge = await fingerprint({
    purpose: "inklark-enroll-v1",
    deviceId,
    userHandle,
    publicKey: profile.credential.publicKey,
    nonce: randomId(),
  });
  const { verified } = await authenticate(
    profile,
    enrollmentChallenge,
    Date.now() + 60000,
  );
  profile.credential.counter = verified.counter;
  // A concurrent enrollment must not silently replace an existing profile.
  await transaction("device", "readwrite", (s) => s.add(profile, KEY));
  return profile;
}
export function publicDevice(profile) {
  return {
    version: 1,
    deviceId: profile.deviceId,
    name: profile.name,
    credential: { ...profile.credential },
    deliveryPublicKey: profile.deliveryPublicKey,
    appearanceRevision: profile.appearanceRevision,
  };
}
function validHash(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
export async function makeApprovalIntent(
  { requestId, documentHash, outputHash, editsHash, expiresAt },
  profile,
) {
  if (
    ![requestId, documentHash, outputHash, editsHash].every(validHash) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 30 * 60000
  )
    throw Error("Invalid signing request.");
  return Object.freeze({
    version: 1,
    requestId,
    documentHash,
    outputHash,
    editsHash,
    deviceId: profile.deviceId,
    credentialId: profile.credential.id,
    signerName: profile.name,
    appearanceRevision: profile.appearanceRevision,
    nonce: randomId(),
    expiresAt,
  });
}
export async function approveIntent(intent) {
  const profile = await getDevice();
  if (
    !profile ||
    intent.deviceId !== profile.deviceId ||
    intent.credentialId !== profile.credential.id ||
    intent.signerName !== profile.name ||
    intent.appearanceRevision !== profile.appearanceRevision
  )
    throw Error("The request does not match this signing profile.");
  if (!validHash(intent.nonce) || intent.version !== 1)
    throw Error("Invalid approval request.");
  if (await transaction("approvals", "readonly", (s) => s.get(intent.nonce)))
    throw Error("This signing request was already approved.");
  const pinned = canonical(intent);
  const challenge = await approvalChallenge(intent);
  const { assertion, verified } = await authenticate(
    profile,
    challenge,
    intent.expiresAt,
  );
  if (canonical(intent) !== pinned)
    throw Error("The signing request changed during authentication.");
  // IndexedDB's unique-key transaction enforces one-use even for authenticators
  // whose signature counter remains zero, and across concurrent browser tabs.
  await transaction("approvals", "readwrite", (s) =>
    s.add({ nonce: intent.nonce, challenge, expiresAt: intent.expiresAt }),
  );
  profile.credential.counter = verified.counter;
  await saveDevice(profile);
  return {
    format: "inklark-approval",
    version: 1,
    intent: JSON.parse(pinned),
    assertion,
  };
}
export async function verifyApprovalRecord(
  record,
  pinnedCredential,
  pinnedIntent,
  origin,
) {
  if (
    record.format !== "inklark-approval" ||
    record.version !== 1 ||
    canonical(record.intent) !== canonical(pinnedIntent)
  )
    throw Error("The approval does not match the pinned request.");
  return verifyApproval(record.assertion, pinnedCredential, {
    challenge: await approvalChallenge(pinnedIntent),
    expiresAt: pinnedIntent.expiresAt,
    origin,
    rpId: new URL(origin).hostname,
  });
}
