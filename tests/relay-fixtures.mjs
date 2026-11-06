import { generateKeyPairSync, sign } from "node:crypto";
import {
  randomId,
  createDeliveryKey,
  publicDeliveryKey,
  fingerprint,
  digest,
  utf8,
  base64url,
  unbase64url,
  approvalChallenge,
} from "../src/trust.js";

export async function syntheticSigner(origin) {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const delivery = await createDeliveryKey();
  const device = {
    version: 1,
    deviceId: randomId(),
    name: "Jane Example",
    appearanceRevision: randomId(),
    deliveryPublicKey: await publicDeliveryKey(delivery.publicKey),
    credential: {
      id: randomId(),
      userHandle: randomId(),
      publicKey: base64url(
        key.publicKey.export({ format: "der", type: "spki" }),
      ),
      backupEligible: false,
    },
  };
  let counter = 0;
  async function assertion(challenge, flags = 5) {
    const client = utf8(
      JSON.stringify({
        type: "webauthn.get",
        challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const auth = new Uint8Array(37);
    auth.set(unbase64url(await digest(utf8(new URL(origin).hostname))));
    auth[32] = flags;
    new DataView(auth.buffer).setUint32(33, ++counter);
    const signature = sign(
      "sha256",
      Buffer.concat([auth, unbase64url(await digest(client))]),
      key.privateKey,
    );
    return {
      id: device.credential.id,
      rawId: device.credential.id,
      type: "public-key",
      response: {
        clientDataJSON: base64url(client),
        authenticatorData: base64url(auth),
        signature: base64url(signature),
        userHandle: device.credential.userHandle,
      },
    };
  }
  const intent = {
    purpose: "inklark-enroll-v1",
    device,
    nonce: randomId(),
    expiresAt: Date.now() + 60000,
  };
  const registration = {
    device,
    proof: { intent, assertion: await assertion(await fingerprint(intent)) },
  };
  return {
    device,
    delivery,
    registration,
    approve: async (intent) => ({
      format: "inklark-approval",
      version: 1,
      intent,
      assertion: await assertion(await approvalChallenge(intent)),
    }),
  };
}
