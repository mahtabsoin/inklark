import test from "node:test";
import assert from "node:assert/strict";
import {
  createVault,
  saveVault,
  unlockVault,
  parseVault,
} from "../src/vault.js";
globalThis.localStorage = {
  values: new Map(),
  setItem(k, v) {
    this.values.set(k, v);
  },
  getItem(k) {
    return this.values.get(k) || null;
  },
};
test("vault encrypts names and signatures, rejects wrong passwords and tampering", async () => {
  const vault = await createVault("a sufficiently long test password");
  vault.signatures.push({
    id: "owner",
    name: "Private Person",
    png: "data:image/png;base64,AA==",
    ratio: 3,
  });
  const first = await saveVault(vault),
    second = await saveVault(vault);
  assert.notEqual(first, second);
  assert.equal(first.includes("Private Person"), false);
  assert.equal(first.includes("data:image/png"), false);
  assert.equal(
    (await unlockVault(first, "a sufficiently long test password"))
      .signatures[0].name,
    "Private Person",
  );
  await assert.rejects(
    () => unlockVault(first, "wrong password"),
    /did not unlock/,
  );
  const tampered = JSON.parse(first);
  tampered.ciphertext = "AAAA" + tampered.ciphertext.slice(4);
  await assert.rejects(
    () =>
      unlockVault(
        JSON.stringify(tampered),
        "a sufficiently long test password",
      ),
    /did not unlock/,
  );
});
test("vault import bounds work factor and rejects plaintext payloads", async () => {
  await assert.rejects(() => createVault("short"), /12 characters/);
  assert.throws(
    () =>
      parseVault(
        JSON.stringify({
          format: "fillsign-vault",
          version: 1,
          iterations: 999999999,
        }),
      ),
    /valid Inklark/,
  );
});
