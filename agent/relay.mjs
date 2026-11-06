import { fingerprint, digest, utf8 } from "../src/trust.js";
import {
  validateManifest,
  verifyChunk,
  CHUNK_CHARS,
  deliveryFingerprint,
} from "../src/delivery.js";
import {
  verifyDeviceRegistration,
  verifyApprovalRecord,
} from "../src/device.js";

const isHash = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const tool = (
  name,
  description,
  properties,
  required = Object.keys(properties),
  readOnly = false,
) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  },
  annotations: {
    readOnlyHint: readOnly,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});
export const RELAY_TOOLS = [
  tool(
    "get_signing_device",
    "Get the human's paired signing device and encryption public key. Prepare PDFs in your own runtime. Encrypt the full request for this key before uploading. The relay accepts ciphertext only. Use Inklark's remote adapter to create the manifest and chunks; never send plaintext answers or PDFs as tool arguments.",
    {},
    [],
    true,
  ),
  tool(
    "start_signing_request",
    "Reserve an encrypted document delivery using the adapter's manifest. This never authorizes signing. Reuse the same request ID and manifest for retries.",
    { manifest: { type: "object" } },
  ),
  tool(
    "upload_signing_chunk",
    "Upload one ciphertext chunk produced by the adapter. Use the manifest's exact chunk index. Retrying the identical chunk is safe.",
    {
      request_id: { type: "string" },
      index: { type: "integer", minimum: 0, maximum: 255 },
      ciphertext: { type: "string", maxLength: CHUNK_CHARS },
    },
  ),
  tool(
    "finish_signing_request",
    "Make a fully uploaded encrypted request available to the paired device. Return the handoff link to the human. Never operate the human signing screen or approve a request.",
    { request_id: { type: "string" } },
  ),
  tool(
    "get_request_status",
    "Read completion status only. The PDF stays on the human device; an output hash is not proof of delivery or independently verified legal identity.",
    { request_id: { type: "string" } },
    ["request_id"],
    true,
  ),
];
async function readJSON(request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw Error("Use JSON for this operation.");
  const reader = request.body?.getReader();
  if (!reader) throw Error("Request body is missing.");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > CHUNK_CHARS + 65536) {
        await reader.cancel();
        throw Error("Request body exceeds the operation limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw Error("The request is not valid JSON.");
  }
}
function publicDevice(device) {
  return {
    deviceId: device.deviceId,
    signerName: device.name,
    deliveryPublicKey: device.deliveryPublicKey,
    appearanceRevision: device.appearanceRevision,
  };
}
function status(row, now) {
  return {
    requestId: row.request_id,
    status:
      row.state !== "completed" && row.expires_at <= now
        ? "expired"
        : row.state,
    ...(row.state === "completed"
      ? {
          receipt: {
            outputHash: row.output_hash,
            stage: "created_on_device",
            recordedAt: row.completed_at,
          },
        }
      : {}),
  };
}
const keyFor = async (owner, id, index) =>
  `${await digest(utf8(owner))}/${id}/${index}`;

// Repeated sweeps also collect writes left behind by an interrupted uploader.
// A hosted deployment must schedule this independently of browser activity.
export async function sweepRelay(store, { owner = null, now = Date.now(), limit = 50 } = {}) {
  const rows = await store.cleanupCandidates(owner, now, limit);
  for (const row of rows) {
    const keys = await Promise.all(row.manifest.chunks.map((_, index) =>
      keyFor(row.owner, row.request_id, index)));
    await store.bucket.delete(keys);
    await store.markDeleted(row.owner, row.request_id, now);
  }
  await store.prune(owner, now);
  return { swept: rows.length };
}

export function createRelay({ store, origin, now = () => Date.now(), enrollmentAllowed = false }) {
  const expectedOrigin = new URL(origin).origin;
  async function paired(owner) {
    const device = await store.device(owner);
    if (!device)
      throw Error(
        "Open Inklark on your signing device and finish pairing first.",
      );
    return device;
  }
  async function requestFor(owner, id) {
    if (!isHash(id)) throw Error("Invalid request ID.");
    const row = await store.request(owner, id);
    if (!row) throw Error("This request is unavailable.");
    return row;
  }
  async function cleanup(owner) {
    await sweepRelay(store, { owner, now: now(), limit: 5 });
  }
  async function call(owner, name, args) {
    if (["start_signing_request", "get_request_status"].includes(name))
      await cleanup(owner).catch(() => {});
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw Error("Invalid tool arguments.");
    const schema = RELAY_TOOLS.find((t) => t.name === name)?.inputSchema;
    if (
      !schema ||
      Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key)) ||
      schema.required.some((key) => !Object.hasOwn(args, key))
    )
      throw Error("Unknown tool or invalid arguments.");
    if (name === "get_signing_device") {
      const target = publicDevice(await paired(owner));
      return {
        ...target,
        fingerprint: await deliveryFingerprint(target),
        signingUrl: expectedOrigin + "/sign.html",
      };
    }
    if (name === "start_signing_request") {
      const manifest = await validateManifest(args.manifest, now()),
        device = await paired(owner);
      if (manifest.route.deviceId !== device.deviceId)
        throw Error("This request targets a different signing device.");
      const hash = await fingerprint(manifest),
        prior = await store.request(owner, manifest.route.requestId);
      if (prior) {
        if (prior.delivery_hash !== hash)
          throw Error("The request ID already belongs to different content.");
        return status(prior, now());
      }
      if (!(await store.start(owner, manifest, hash, now())))
        throw Error("Finish an existing request before submitting another.");
      return { requestId: manifest.route.requestId, status: "uploading" };
    }
    const row = await requestFor(owner, args.request_id);
    if (name === "get_request_status") return status(row, now());
    if (row.expires_at <= now())
      throw Error("This request expired. Prepare a new request.");
    if (name === "upload_signing_chunk") {
      if (row.state !== "uploading")
        throw Error("This request no longer accepts uploads.");
      await verifyChunk(row.manifest, args.index, args.ciphertext);
      const key = await keyFor(owner, row.request_id, args.index);
      await store.bucket.put(key, args.ciphertext);
      await store.chunk(owner, row.request_id, args.index, now());
      const current = await store.request(owner, row.request_id);
      if (!current || current.expires_at <= now() || !["uploading", "pending"].includes(current.state)) {
        // A put may finish after cleanup. Remove that late write explicitly.
        await store.bucket.delete(key);
        throw Error("This request closed during upload. Prepare a new request.");
      }
      return { requestId: row.request_id, index: args.index, status: "stored" };
    }
    if (name === "finish_signing_request") {
      if (!["uploading", "pending"].includes(row.state))
        return status(row, now());
      if (
        (await store.chunkCount(owner, row.request_id)) !==
        row.manifest.chunks.length
      )
        throw Error(
          "The encrypted upload is incomplete. Retry the missing chunks.",
        );
      await store.finish(owner, row.request_id, now());
      const current = await requestFor(owner, row.request_id);
      if (current.state !== "pending" || current.expires_at <= now())
        return status(current, now());
      return {
        requestId: row.request_id,
        status: "pending",
        openUrl: expectedOrigin + "/sign.html?request=" + row.request_id,
      };
    }
    throw Error("Unknown operation.");
  }
  async function complete(owner, record) {
    const intent = record?.intent,
      row = await requestFor(owner, intent?.requestId),
      device = await paired(owner);
    const approvalHash = await fingerprint(record);
    if (row.state === "completed") {
      if (row.approval_hash !== approvalHash)
        throw Error("This request already has a different approval.");
      return status(row, now());
    }
    if (row.state !== "pending" || row.expires_at <= now())
      throw Error("This request is not awaiting approval.");
    const fields =
      "appearanceRevision,credentialId,deliveryHash,deviceId,documentHash,editsHash,expiresAt,nonce,outputHash,requestId,signerName,version";
    if (
      !intent ||
      Object.keys(intent).sort().join(",") !== fields ||
      intent.version !== 1 ||
      ![
        intent.documentHash,
        intent.editsHash,
        intent.outputHash,
        intent.nonce,
      ].every(isHash) ||
      intent.expiresAt !== row.expires_at ||
      intent.deviceId !== device.deviceId ||
      intent.credentialId !== device.credential.id ||
      intent.signerName !== device.name ||
      intent.appearanceRevision !== device.appearanceRevision ||
      intent.deliveryHash !== row.delivery_hash
    )
      throw Error(
        "The approval does not match the delivered request and signer.",
      );
    const verified = await verifyApprovalRecord(
      record,
      device.credential,
      intent,
      expectedOrigin,
    );
    if (
      !(await store.complete(
        owner,
        row,
        device,
        record,
        approvalHash,
        verified.counter,
        now(),
      ))
    )
      throw Error("The request changed or completed during approval.");
    // Cleanup is retryable and never creates another authorization.
    await cleanup(owner).catch(() => {});
    return status(await requestFor(owner, row.request_id), now());
  }
  return async function handle(request, owner) {
    if (typeof owner !== "string" || !owner || owner.length > 256)
      return json({ error: "Sign in to connect your device and agent." }, 401);
    const url = new URL(request.url),
      requestOrigin = request.headers.get("origin");
    if (
      url.origin !== expectedOrigin ||
      (requestOrigin && requestOrigin !== expectedOrigin)
    )
      return json({ error: "Invalid request origin." }, 403);
    try {
      if (url.pathname === "/mcp") {
        if (request.method !== "POST")
          return new Response(null, {
            status: 405,
            headers: { Allow: "POST" },
          });
        const message = await readJSON(request);
        if (message.jsonrpc !== "2.0")
          return json(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "Invalid JSON-RPC request." },
            },
            400,
          );
        if (message.id === undefined)
          return new Response(null, { status: 202 });
        let result;
        if (message.method === "server/discover")
          result = {
            supportedVersions: ["2026-07-28", "2025-11-25"],
            capabilities: { tools: {} },
          };
        else if (message.method === "initialize")
          result = {
            protocolVersion: [
              "2026-07-28",
              "2025-11-25",
              "2025-06-18",
              "2025-03-26",
            ].includes(message.params?.protocolVersion)
              ? message.params.protocolVersion
              : "2025-11-25",
            serverInfo: { name: "inklark", version: "0.2.0-preview" },
            capabilities: { tools: { listChanged: false } },
            instructions:
              "Prepare PDFs in your own runtime, encrypt with the human's paired public key using Inklark's adapter, and deliver ciphertext. Signing is reserved for the human on their device. Never operate the signing screen or fabricate consent.",
          };
        else if (message.method === "ping") result = {};
        else if (message.method === "tools/list")
          result = { tools: RELAY_TOOLS };
        else if (message.method === "tools/call") {
          try {
            const value = await call(
              owner,
              message.params?.name,
              message.params?.arguments || {},
            );
            result = {
              content: [{ type: "text", text: JSON.stringify(value) }],
            };
          } catch (error) {
            result = {
              isError: true,
              content: [{ type: "text", text: error.message }],
            };
          }
        } else
          return json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found." },
          });
        return json({ jsonrpc: "2.0", id: message.id, result });
      }
      if (
        url.pathname.startsWith("/api/") &&
        request.method === "POST" &&
        requestOrigin !== expectedOrigin
      )
        return json(
          { error: "Open this operation in the Inklark browser." },
          403,
        );
      if (url.pathname === "/api/relay" && request.method === "GET") {
        const device = await store.device(owner);
        return json({
          enabled: true,
          enrollmentEnabled: enrollmentAllowed,
          mcpUrl: expectedOrigin + "/mcp",
          device: device ? publicDevice(device) : null,
        });
      }
      if (url.pathname === "/api/device" && request.method === "POST") {
        // Origin is CSRF protection. It is not a human identity boundary.
        // The trusted host adapter must establish a browser-only admission path.
        if (!enrollmentAllowed)
          return json({ error: "Device enrollment is disabled until this host verifies browser-only access." }, 503);
        const registration = await readJSON(request),
          hash = await fingerprint(registration),
          prior = await store.device(owner);
        if (prior) {
          if (prior.registrationHash !== hash)
            throw Error(
              "A signing device is already paired. Existing credentials cannot be replaced by this operation.",
            );
          return json({ device: publicDevice(prior) });
        }
        const device = await verifyDeviceRegistration(
          registration,
          expectedOrigin,
        );
        if (!(await store.register(owner, device, hash)))
          throw Error(
            "A signing device was paired concurrently. Reload Inklark.",
          );
        return json({ device: publicDevice(device) }, 201);
      }
      if (url.pathname === "/api/inbox" && request.method === "GET") {
        await cleanup(owner).catch(() => {});
        const device = await paired(owner);
        if (url.searchParams.get("device") !== device.deviceId)
          throw Error("This browser is not the paired device.");
        return json({
          requests: (await store.inbox(owner, device.deviceId, now())).map(
            (row) => ({
              manifest: row.manifest,
              deliveryHash: row.delivery_hash,
            }),
          ),
        });
      }
      const match = url.pathname.match(
        /^\/api\/chunks\/([A-Za-z0-9_-]{43})\/(\d{1,4})$/,
      );
      if (match && request.method === "GET") {
        const row = await requestFor(owner, match[1]),
          index = Number(match[2]);
        if (
          row.state !== "pending" ||
          row.expires_at <= now() ||
          !row.manifest.chunks[index]
        )
          throw Error("This encrypted chunk is unavailable.");
        const object = await store.bucket.get(
          await keyFor(owner, row.request_id, index),
        );
        if (!object)
          throw Error(
            "The encrypted upload is incomplete. Ask the agent to retry it.",
          );
        return new Response(await object.text(), {
          headers: {
            "Content-Type": "text/plain",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (url.pathname === "/api/complete" && request.method === "POST")
        return json(await complete(owner, await readJSON(request)));
      const statusMatch = url.pathname.match(/^\/api\/status\/([A-Za-z0-9_-]{43})$/);
      if (statusMatch && request.method === "GET") {
        await cleanup(owner).catch(() => {});
        return json(status(await requestFor(owner, statusMatch[1]), now()));
      }
      if (url.pathname === "/api/cancel" && request.method === "POST") {
        const body = await readJSON(request);
        const row = await requestFor(owner, body.requestId);
        await store.cancel(owner, row.request_id);
        await cleanup(owner).catch(() => {});
        return json(status(await requestFor(owner, row.request_id), now()));
      }
      return json({ error: "Unknown relay endpoint." }, 404);
    } catch (error) {
      return json({ error: error.message }, 400);
    }
  };
}
