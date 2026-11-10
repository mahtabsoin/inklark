import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  utf8,
  base64url,
  unbase64url,
  digest,
  canonical,
  randomId,
  createDeliveryKey,
  publicDeliveryKey,
  sealRequest,
  openRequest,
  verifyApproval,
  verifyApprovalEvidence,
  MAX_DELIVERY_BYTES,
  approvalChallenge,
  es256Signature,
} from "../src/trust.js";

test("device delivery encrypts document data and authenticates routing metadata", async () => {
  const device = await createDeliveryKey();
  assert.equal(device.privateKey.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey("jwk", device.privateKey));
  const route = {
    version: 1,
    deviceId: randomId(),
    requestId: randomId(),
    expiresAt: Date.now() + 60000,
  };
  const payload = {
    document: "synthetic-pdf-bytes",
    answers: { name: "Jane Example" },
  };
  const envelope = await sealRequest(
    payload,
    await publicDeliveryKey(device.publicKey),
    route,
  );
  assert.equal(JSON.stringify(envelope).includes("Jane Example"), false);
  assert.deepEqual(
    await openRequest(envelope, device.privateKey, route.deviceId),
    payload,
  );
  const other = await createDeliveryKey();
  await assert.rejects(() =>
    openRequest(envelope, other.privateKey, route.deviceId),
  );
  await assert.rejects(
    () => openRequest(envelope, device.privateKey, randomId()),
    /another device/,
  );
  await assert.rejects(() =>
    openRequest(
      { ...envelope, route: { ...route, requestId: randomId() } },
      device.privateKey,
      route.deviceId,
    ),
  );
  await assert.rejects(
    () =>
      openRequest(
        { ...envelope, route: { ...route, expiresAt: Date.now() - 1 } },
        device.privateKey,
        route.deviceId,
      ),
    /expired/,
  );
  const altered = unbase64url(envelope.ciphertext);
  altered[0] ^= 1;
  await assert.rejects(() =>
    openRequest(
      { ...envelope, ciphertext: base64url(altered) },
      device.privateKey,
      route.deviceId,
    ),
  );
});

test("canonical approval hashes change with document, signer, placement, and request nonce", async () => {
  const intent = {
    documentHash: randomId(),
    signerId: randomId(),
    placements: [{ page: 1, x: 50, y: 100 }],
    nonce: randomId(),
  };
  const hash = await approvalChallenge(intent);
  assert.equal(hash, await approvalChallenge({ ...intent }));
  for (const changed of [
    { ...intent, documentHash: randomId() },
    { ...intent, signerId: randomId() },
    { ...intent, placements: [{ page: 1, x: 51, y: 100 }] },
    { ...intent, nonce: randomId() },
  ])
    assert.notEqual(hash, await approvalChallenge(changed));
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  assert.throws(() => canonical({ invalid: undefined }));
  assert.throws(() => canonical({ invalid: NaN }));
  assert.throws(() => unbase64url("AA=="));
  assert.throws(() => unbase64url("AB"));
});

async function assertionFixture(overrides = {}) {
  const rsa = overrides.algorithm === -257;
  const pair = overrides.pair || generateKeyPairSync(
    rsa ? "rsa" : "ec",
    rsa ? { modulusLength: overrides.modulusLength || 2048, publicExponent: 65537 } : { namedCurve: "prime256v1" },
  );
  const credential = {
    id: randomId(),
    userHandle: randomId(),
    publicKey: base64url(
      pair.publicKey.export({ format: "der", type: "spki" }),
    ),
    counter: 0,
    backupEligible: false,
    ...(overrides.algorithm === undefined ? {} : { algorithm: overrides.algorithm }),
  };
  const expected = {
    challenge: randomId(),
    origin: "https://inklark.example",
    rpId: "inklark.example",
    expiresAt: Date.now() + 60000,
  };
  const client = {
    type: "webauthn.get",
    challenge: expected.challenge,
    origin: expected.origin,
    crossOrigin: false,
    ...overrides.client,
  };
  const clientBytes = utf8(JSON.stringify(client));
  const data = new Uint8Array(37 + (overrides.trailingBytes || 0));
  data.set(unbase64url(await digest(utf8(overrides.rpId || expected.rpId))));
  data[32] = overrides.flags ?? 5;
  new DataView(data.buffer).setUint32(33, overrides.counter ?? 1);
  const signed = Buffer.concat([data, unbase64url(await digest(clientBytes))]);
  const signature = sign("sha256", signed, pair.privateKey);
  const assertion = {
    id: credential.id,
    rawId: credential.id,
    type: "public-key",
    response: {
      clientDataJSON: base64url(clientBytes),
      authenticatorData: base64url(data),
      signature: base64url(signature),
      userHandle: credential.userHandle,
    },
  };
  return { credential, expected, assertion, pair };
}
test("ES256 approval verifies a real signature and enforces user verification", async () => {
  const { assertion, credential, expected } = await assertionFixture();
  assert.equal(
    (await verifyApproval(assertion, credential, expected)).counter,
    1,
  );
  await assert.rejects(
    () => verifyApproval(assertion, { ...credential, counter: 1 }, expected),
    /already used/,
  );
  await assert.rejects(
    () =>
      verifyApproval(assertion, { ...credential, id: randomId() }, expected),
    /credential/,
  );
  await assert.rejects(
    () =>
      verifyApproval(assertion, credential, {
        ...expected,
        challenge: randomId(),
      }),
    /operation/,
  );
  await assert.rejects(
    () => verifyApproval(assertion, credential, { ...expected, expiresAt: 0 }),
    /expired/,
  );
  const other = await assertionFixture();
  await assert.rejects(
    () =>
      verifyApproval(
        assertion,
        { ...credential, publicKey: other.credential.publicKey },
        expected,
      ),
    /signature/,
  );
  for (const overrides of [
    { flags: 1 },
    { flags: 4 },
    { flags: 5 | 0x40 },
    { flags: 5 | 0x10 },
    { flags: 5 | 0x80 },
    { trailingBytes: 1 },
    { client: { crossOrigin: true } },
    { client: { type: "webauthn.create" } },
    { client: { origin: "https://attacker.example" } },
    { rpId: "attacker.example" },
  ]) {
    const bad = await assertionFixture(overrides);
    await assert.rejects(() =>
      verifyApproval(bad.assertion, bad.credential, bad.expected),
    );
  }
  const badSignature = {
    ...assertion,
    response: {
      ...assertion.response,
      signature: base64url(new Uint8Array(8)),
    },
  };
  await assert.rejects(() =>
    verifyApproval(badSignature, credential, expected),
  );
  await assert.rejects(
    () =>
      verifyApproval(
        {
          ...assertion,
          response: { ...assertion.response, userHandle: randomId() },
        },
        credential,
        expected,
      ),
    /handle/,
  );
  await assert.rejects(
    () =>
      verifyApproval(
        assertion,
        { ...credential, backupEligible: true },
        expected,
      ),
    /verification/,
  );
  const zero = await assertionFixture({ counter: 0 });
  assert.equal(
    (await verifyApproval(zero.assertion, zero.credential, zero.expected))
      .counter,
    0,
  );
});
test("historical evidence verifies signature binding without granting fresh authorization", async () => {
  const { assertion, credential, expected } = await assertionFixture();
  await assert.rejects(() =>
    verifyApproval(
      assertion,
      { ...credential, counter: 100 },
      { ...expected, expiresAt: 0 },
    ),
  );
  const evidence = await verifyApprovalEvidence(
    assertion,
    { ...credential, counter: 100 },
    { ...expected, expiresAt: 0 },
  );
  assert.equal(evidence.signatureVerified, true);
  assert.equal(evidence.freshAuthorization, false);
});
test("RS256 approval supports Windows Hello keys without weakening signature or user checks", async () => {
  const { assertion, credential, expected, pair } = await assertionFixture({ algorithm: -257 });
  assert.equal((await verifyApproval(assertion, credential, expected)).counter, 1);
  await assert.rejects(() => verifyApproval(assertion, { ...credential, algorithm: -7 }, expected));
  await assert.rejects(() => verifyApproval(assertion, { ...credential, algorithm: -258 }, expected), /algorithm/);
  await assert.rejects(() => verifyApproval(assertion, { ...credential, algorithm: null }, expected), /algorithm/);
  await assert.rejects(() => verifyApproval(assertion, { ...credential, counter: 1 }, expected), /already used/);
  await assert.rejects(() => verifyApproval(assertion, credential, { ...expected, challenge: randomId() }), /operation/);
  await assert.rejects(() => verifyApproval(assertion, credential, { ...expected, expiresAt: 0 }), /expired/);
  for (const overrides of [
    { flags: 1 },
    { flags: 4 },
    { flags: 5 | 0x40 },
    { client: { origin: "https://attacker.example" } },
    { rpId: "attacker.example" },
  ]) {
    const bad = await assertionFixture({ ...overrides, algorithm: -257, pair });
    await assert.rejects(() => verifyApproval(bad.assertion, bad.credential, bad.expected));
  }
  const corrupt = unbase64url(assertion.response.signature);
  corrupt[0] ^= 1;
  await assert.rejects(() => verifyApproval({ ...assertion, response: { ...assertion.response, signature: base64url(corrupt) } }, credential, expected), /signature/);
  await assert.rejects(() => verifyApproval({ ...assertion, response: { ...assertion.response, signature: base64url(corrupt.subarray(1)) } }, credential, expected), /length/);
  const weak = await assertionFixture({ algorithm: -257, modulusLength: 1024 });
  await assert.rejects(() => verifyApproval(weak.assertion, weak.credential, weak.expected), /parameters/);
  const evidence = await verifyApprovalEvidence(assertion, { ...credential, counter: 100 }, { ...expected, expiresAt: 0 });
  assert.equal(evidence.freshAuthorization, false);
});
test("delivery accepts a base64-sized 30 MiB PDF and rejects oversized plaintext before encryption", async () => {
  const device = await createDeliveryKey();
  const route = {
    version: 1,
    deviceId: randomId(),
    requestId: randomId(),
    expiresAt: Date.now() + 60000,
  };
  const payload = { document: "A".repeat(40 * 1024 * 1024) };
  const envelope = await sealRequest(
    payload,
    await publicDeliveryKey(device.publicKey),
    route,
  );
  const opened = await openRequest(envelope, device.privateKey, route.deviceId);
  assert.equal(opened.document.length, payload.document.length);
  await assert.rejects(
    () =>
      sealRequest(
        { document: "A".repeat(MAX_DELIVERY_BYTES) },
        device.publicKey,
        route,
      ),
    /delivery limit/,
  );
});
test("ES256 signature decoding refuses malformed and noncanonical DER", () => {
  for (const bytes of [
    [],
    [0x30, 4, 2, 0, 2, 0],
    [0x30, 6, 2, 1, 128, 2, 1, 1],
    [0x30, 7, 2, 2, 0, 1, 2, 1, 1],
  ])
    assert.throws(() => es256Signature(Uint8Array.from(bytes)));
});
