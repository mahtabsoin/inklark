const KEY = "fillsign.encrypted-vault.v1";
const ITERATIONS = 600000;
const encode = (bytes) => {
  const data = new Uint8Array(bytes);
  let text = "";
  for (let i = 0; i < data.length; i += 32768)
    text += String.fromCharCode(...data.subarray(i, i + 32768));
  return btoa(text);
};
const decode = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
export const storedVault = () => localStorage.getItem(KEY);
export function parseVault(raw) {
  if (typeof raw !== "string" || raw.length > 4 * 1024 * 1024)
    throw Error("The vault file is too large.");
  const v = JSON.parse(raw);
  if (
    v.format !== "fillsign-vault" ||
    v.version !== 1 ||
    v.iterations !== ITERATIONS ||
    decode(v.salt).length !== 16 ||
    decode(v.iv).length !== 12 ||
    typeof v.ciphertext !== "string"
  )
    throw Error("Choose a valid Inklark encrypted vault.");
  return v;
}
async function derive(password, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function createVault(password) {
  if (password.length < 12)
    throw Error("Use a vault password with at least 12 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await derive(password, salt), salt, signatures: [] };
}
export async function unlockVault(raw, password) {
  const envelope = parseVault(raw),
    salt = decode(envelope.salt),
    key = await derive(password, salt);
  let data;
  try {
    data = JSON.parse(
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: decode(envelope.iv) },
          key,
          decode(envelope.ciphertext),
        ),
      ),
    );
  } catch {
    throw Error(
      "The password did not unlock this vault, or the file has changed.",
    );
  }
  if (
    !Array.isArray(data.signatures) ||
    data.signatures.length > 20 ||
    data.signatures.some(
      (s) =>
        typeof s.id !== "string" ||
        typeof s.name !== "string" ||
        !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s.png) ||
        s.png.length > 500000,
    )
  )
    throw Error("This vault contains invalid signature data.");
  return { key, salt, signatures: data.signatures };
}
export async function saveVault(vault) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(
    JSON.stringify({ signatures: vault.signatures }),
  );
  if (data.length > 2500000)
    throw Error("The vault is full. Remove a signature before adding another.");
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    vault.key,
    data,
  );
  const raw = JSON.stringify({
    format: "fillsign-vault",
    version: 1,
    iterations: ITERATIONS,
    salt: encode(vault.salt),
    iv: encode(iv),
    ciphertext: encode(ciphertext),
  });
  localStorage.setItem(KEY, raw);
  return raw;
}
export function importVault(raw) {
  parseVault(raw);
  localStorage.setItem(KEY, raw);
}
