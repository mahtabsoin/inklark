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
  verifyApprovalEvidence,
  approvalChallenge,
} from "./trust.js";

const DB = "inklark-device-v1";
const KEY = "active-device";
const OUTPUT_LIMIT = 45 * 1024 * 1024;
const OUTPUT_TTL = 30 * 60000;
function database() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 2);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains("device"))
        open.result.createObjectStore("device");
      const approvals = open.result.objectStoreNames.contains("approvals")
        ? open.transaction.objectStore("approvals")
        : open.result.createObjectStore("approvals", { keyPath: "nonce" });
      if (!approvals.indexNames.contains("requestId"))
        approvals.createIndex("requestId", "record.intent.requestId");
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
export const getApprovalRecord = (nonce) =>
  transaction("approvals", "readonly", (s) => s.get(nonce));
export async function hasRequestApproval(requestId) {
  return !!(await transaction("approvals", "readonly", (s) =>
    s.index("requestId").getKey(requestId),
  ));
}
async function commitApproval(profile, record, verified, output) {
  const db = await database();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["device", "approvals"], "readwrite");
      const devices = tx.objectStore("device"),
        approvals = tx.objectStore("approvals");
      const current = devices.get(KEY);
      current.onsuccess = () => {
        const stored = current.result;
        if (
          !stored ||
          canonical(enrollmentDevice(stored)) !==
            canonical(enrollmentDevice(profile))
        ) {
          tx.abort();
          return;
        }
        const prior = approvals.index("requestId").get(record.intent.requestId);
        prior.onsuccess = () => {
          if (prior.result) {
            tx.abort();
            return;
          }
          approvals.add({
            nonce: record.intent.nonce,
            expiresAt: record.intent.expiresAt,
            record,
            ...(output ? { output } : {}),
          });
          devices.put(
            {
              ...stored,
              credential: {
                ...stored.credential,
                counter: Math.max(stored.credential.counter, verified.counter),
              },
            },
            KEY,
          );
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(
          Error(
            "The approval could not be saved or was already completed. Nothing new was signed.",
          ),
        );
    });
  } finally {
    db.close();
  }
}

async function outputKey(profile) {
  const candidate = profile.outputKey || {
    id: randomId(),
    key: await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
  };
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      let selected;
      const tx = db.transaction("device", "readwrite"),
        store = tx.objectStore("device"),
        read = store.get(KEY);
      read.onsuccess = () => {
        const current = read.result;
        if (
          !current ||
          canonical(enrollmentDevice(current)) !== canonical(enrollmentDevice(profile))
        ) {
          tx.abort();
          return;
        }
        selected = current.outputKey || candidate;
        if (!current.outputKey) store.put({ ...current, outputKey: selected }, KEY);
      };
      tx.oncomplete = () => resolve(selected);
      tx.onabort = tx.onerror = () => reject(
        Error("Local recovery storage is unavailable. Nothing was signed."),
      );
    });
  } finally {
    db.close();
  }
}
function outputAAD(intent, output) {
  return utf8(canonical({
    purpose: "inklark-local-output-v1",
    intent,
    keyId: output.keyId,
    expiresAt: output.expiresAt,
  }));
}
async function encryptOutput(profile, intent, artifact) {
  const bytes = new Uint8Array(artifact.bytes);
  if (
    !bytes.length || bytes.length > OUTPUT_LIMIT ||
    await digest(bytes) !== intent.outputHash
  )
    throw Error("The recovery PDF does not match the approved output.");
  const { name, pages, signatureCount } = artifact;
  if (
    typeof name !== "string" || name.length > 512 ||
    !Number.isInteger(pages) || pages < 1 || pages > 100 ||
    !Number.isInteger(signatureCount) || signatureCount < 1 || signatureCount > 1000
  )
    throw Error("Invalid recovery document details.");
  const header = utf8(JSON.stringify({ name, pages, signatureCount }));
  const payload = new Uint8Array(4 + header.length + bytes.length);
  new DataView(payload.buffer).setUint32(0, header.length);
  payload.set(header, 4);
  payload.set(bytes, 4 + header.length);
  const key = await outputKey(profile);
  const output = {
    version: 1,
    keyId: key.id,
    expiresAt: Date.now() + OUTPUT_TTL,
    iv: crypto.getRandomValues(new Uint8Array(12)),
    notificationPending: !!intent.deliveryHash,
  };
  output.ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: output.iv, additionalData: outputAAD(intent, output) },
    key.key,
    payload,
  ));
  return output;
}

export async function getRecoveryRequest(preferredId) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      let selected = null;
      const tx = db.transaction("approvals", "readwrite"),
        store = tx.objectStore("approvals"),
        cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        const row = c.value;
        if (row.output?.expiresAt <= Date.now()) {
          delete row.output;
          c.update(row);
        } else if (
          row.output && !selected &&
          (preferredId ? row.record.intent.requestId === preferredId : row.output.notificationPending)
        )
          selected = row.record.intent.requestId;
        c.continue();
      };
      tx.oncomplete = () => resolve(selected);
      tx.onabort = tx.onerror = () => reject(Error("Local recovery could not be read."));
    });
  } finally {
    db.close();
  }
}
export async function recoverApprovedOutput(requestId) {
  if (!validHash(requestId)) throw Error("Invalid recovery request.");
  const row = await transaction("approvals", "readonly", (s) =>
    s.index("requestId").get(requestId),
  );
  const output = row?.output,
    profile = await getDevice();
  if (!output || output.expiresAt <= Date.now()) return null;
  if (
    output.version !== 1 || output.keyId !== profile?.outputKey?.id ||
    !(output.iv instanceof Uint8Array) || output.iv.length !== 12 ||
    !(output.ciphertext instanceof Uint8Array) ||
    output.ciphertext.length > OUTPUT_LIMIT + 4116
  )
    throw Error("The saved PDF cannot be recovered on this device.");
  await verifySavedApprovalRecord(row.record, profile.credential, row.record.intent, location.origin);
  const payload = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: output.iv, additionalData: outputAAD(row.record.intent, output) },
    profile.outputKey.key,
    output.ciphertext,
  ));
  const headerLength = new DataView(payload.buffer).getUint32(0);
  if (headerLength > 4096 || headerLength >= payload.length - 4) throw Error("Invalid recovery PDF.");
  const details = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
    payload.subarray(4, 4 + headerLength),
  ));
  const bytes = payload.slice(4 + headerLength);
  if (await digest(bytes) !== row.record.intent.outputHash)
    throw Error("The recovered PDF differs from the approved output.");
  return { ...details, bytes, record: row.record, notificationPending: output.notificationPending };
}
export async function updateCachedOutput(nonce, { notified = false, remove = false } = {}) {
  const db = await database();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction("approvals", "readwrite"),
        store = tx.objectStore("approvals"),
        read = store.get(nonce);
      read.onsuccess = () => {
        const row = read.result;
        if (!row?.output) return;
        if (remove) delete row.output;
        else if (notified) row.output.notificationPending = false;
        store.put(row);
      };
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(Error("Local recovery status could not be saved."));
    });
  } finally {
    db.close();
  }
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
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      attestation: "none",
      timeout: 60000,
    },
  });
  const publicKey = credential?.response.getPublicKey?.();
  const algorithm = credential?.response.getPublicKeyAlgorithm?.();
  if (!publicKey || ![-7, -257].includes(algorithm))
    throw Error(
      "This authenticator does not provide a supported signing credential. Nothing was enrolled.",
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
      algorithm,
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
  const intent = enrollmentIntent(profile);
  const enrollmentChallenge = await fingerprint(intent);
  const { verified, assertion } = await authenticate(
    profile,
    enrollmentChallenge,
    intent.expiresAt,
  );
  profile.credential.counter = verified.counter;
  profile.enrollment = { intent, assertion };
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
export function enrollmentDevice(profile) {
  const { counter, ...credential } = profile.credential;
  return {
    version: 1,
    deviceId: profile.deviceId,
    name: profile.name,
    appearanceRevision: profile.appearanceRevision,
    credential,
    deliveryPublicKey: profile.deliveryPublicKey,
  };
}
export function enrollmentIntent(profile) {
  return {
    purpose: "inklark-enroll-v1",
    device: enrollmentDevice(profile),
    nonce: randomId(),
    expiresAt: Date.now() + 120000,
  };
}
export function deviceRegistration(profile) {
  return { device: enrollmentDevice(profile), proof: profile.enrollment };
}
export async function renewDeviceRegistration() {
  const profile = await getDevice();
  if (!profile) throw Error("Set up device signing first.");
  const intent = enrollmentIntent(profile);
  const { verified, assertion } = await authenticate(
    profile,
    await fingerprint(intent),
    intent.expiresAt,
  );
  const db = await database();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction("device", "readwrite"),
        store = tx.objectStore("device"),
        read = store.get(KEY);
      read.onsuccess = () => {
        const current = read.result;
        if (
          !current ||
          canonical(enrollmentDevice(current)) !==
            canonical(enrollmentDevice(profile))
        ) {
          tx.abort();
          return;
        }
        Object.assign(profile, current, {
          credential: { ...current.credential, counter: Math.max(current.credential.counter, verified.counter) },
          enrollment: { intent, assertion },
        });
        store.put(profile, KEY);
      };
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () =>
        reject(Error("Device pairing could not be saved."));
    });
  } finally {
    db.close();
  }
  return profile;
}
export async function verifyDeviceRegistration(registration, origin) {
  const { device, proof } = registration;
  if (
    !device ||
    device.version !== 1 ||
    !validHash(device.deviceId) ||
    !validHash(device.appearanceRevision) ||
    typeof device.name !== "string" ||
    !device.name.trim() ||
    device.name.length > 80 ||
    !proof ||
    proof.intent?.purpose !== "inklark-enroll-v1" ||
    !validHash(proof.intent.nonce) ||
    canonical(proof.intent.device) !== canonical(device)
  )
    throw Error("Invalid device enrollment.");
  const verified = await verifyApproval(
    proof.assertion,
    { ...device.credential, counter: 0 },
    {
      challenge: await fingerprint(proof.intent),
      expiresAt: proof.intent.expiresAt,
      origin,
      rpId: new URL(origin).hostname,
    },
  );
  if (
    device.deliveryPublicKey?.d ||
    device.deliveryPublicKey?.kty !== "EC" ||
    device.deliveryPublicKey?.crv !== "P-256"
  )
    throw Error("Invalid delivery public key.");
  await crypto.subtle.importKey(
    "jwk",
    device.deliveryPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return {
    ...device,
    credential: { ...device.credential, counter: verified.counter },
  };
}
function validHash(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
export async function makeApprovalIntent(
  { requestId, documentHash, outputHash, editsHash, expiresAt, deliveryHash },
  profile,
) {
  if (
    ![requestId, documentHash, outputHash, editsHash].every(validHash) ||
    (deliveryHash !== undefined && !validHash(deliveryHash)) ||
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
    ...(deliveryHash !== undefined ? { deliveryHash } : {}),
  });
}
export async function approveIntent(intent, artifact) {
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
  if (await hasRequestApproval(intent.requestId))
    throw Error("This signing request was already approved.");
  const pinned = canonical(intent);
  const output = artifact ? await encryptOutput(profile, intent, artifact) : undefined;
  if (canonical(intent) !== pinned) throw Error("The signing request changed before authentication.");
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
  const record = {
    format: "inklark-approval",
    version: 1,
    intent: JSON.parse(pinned),
    assertion,
  };
  await commitApproval(profile, record, verified, output);
  return record;
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
export async function verifySavedApprovalRecord(
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
  return verifyApprovalEvidence(record.assertion, pinnedCredential, {
    challenge: await approvalChallenge(pinnedIntent),
    origin,
    rpId: new URL(origin).hostname,
  });
}
