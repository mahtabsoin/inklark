# Authenticated signing release status

The active goal is the cloud-agent to paired-device journey in [JOURNEY.md](JOURNEY.md). This release is incomplete. Local automation proves the implementation below; it does not prove a hosted connection or physical-phone compatibility.

| Goal criterion | Current evidence | Release gate |
| --- | --- | --- |
| Guided setup | Signing page offers connection and pairing instructions without configuration files | Deploy HTTPS, provision the Site plugin, and test one actual cloud client |
| Agent preparation | Native-field and painted-answer regressions pass; the remote adapter packages prepared PDFs | Verify the cloud client's artifact runtime can run the adapter and call connected tools |
| Direct handoff | HTTP MCP delivery reaches the open signing page automatically through encrypted chunks; SQLite survives restart | Verify hosted storage, authenticated routing, and opening from the actual agent |
| One approval | Real WebAuthn assertions from a virtual authenticator create the local PDF with one signing action; inspection is optional | Test supported physical authenticators and mobile browsers |
| Enforced authorization | Document, edits, signer, destination, expiry, replay, counters, cancellation, and mutation tests pass | Establish browser-only enrollment authority on the hosted gateway |
| Private completion | Agent tools return status and output hash; the PDF is created and downloaded locally; stored payloads are ciphertext | Verify the hosted gateway and client transfer path, retention schedule, and resource limits |
| Verified release | Unit, device, encrypted-relay browser, and built-Worker checks pass locally | Passing public CI, working URL, tested cloud connection, and user test script |

## Implemented preview

The original editor remains available. After building, `npm run dev:relay` starts the experimental signing service at `http://localhost:4320`. This loopback-only development service supplies a fixed test identity. It is unsuitable for exposure to the internet.

Device setup adopts a typed name, creates an ES256 credential, and verifies possession once. The delivery private key is stored as a non-extractable CryptoKey in IndexedDB. Prepared requests arrive while this page is open. A complete request shows **Sign this document**, optional inspection, and dismissal. Flagged answers require acknowledgement. Inspection renders one page at a time to bound phone memory.

The agent-side adapter verifies the destination against a fingerprint copied from the human's device, encrypts the prepared packet using ECDH/HKDF/AES-GCM, and sends bounded ciphertext chunks through remote MCP. Plaintext MCP clients cannot use this delivery path without an artifact runtime. The paired-device fingerprint must come from the human; a relay-provided fingerprint cannot authenticate itself.

Approval binds the input, edits, candidate output, signer, appearance revision, delivery hash, expiry, and nonce. Proof and local nonce consumption are saved atomically. The relay verifies the pinned public credential and commits completion with a counter check. An identical completion retry returns the existing status. A lost finish response can resume without reopening uploads. Failed agent notification can be retried without another authentication.

The relay stores routing data, public device metadata, encrypted document chunks, and approval evidence. Agent responses exclude that evidence and document bytes. This preview handles one paired device and one signer per owner. Recovery, device replacement, revocation, and encrypted handwriting-vault integration remain unfinished.

## Security release gates

Hosted enrollment is disabled by default. Sites documents the same user-identity header for browser and MCP requests, with no documented channel discriminator. An Origin header provides CSRF protection and can be forged by an HTTP client. A software-generated key can also sign a self-created initial credential proof. Before enabling enrollment, prove that MCP credentials cannot reach the human enrollment operation or add a verified browser-only authority. An established device cannot be replaced through the enrollment API.

Cleanup handles completion, cancellation, and expiry. Uploads that finish after cleanup remove their late ciphertext writes. A global sweep revisits closed requests to collect interrupted uploads, then removes metadata after the retention window and a final sweep. The loopback service schedules cleanup; the Worker exports a scheduled handler and its Cloudflare configuration requests a five-minute cron. Sites does not document native Worker cron activation. Hosted unattended cleanup must be configured and verified before release. Access expiry is enforced even if physical deletion is delayed.

The hosted app supplies executable client code. A compromised host or browser can access documents while they are processed. Non-extractable keys do not protect against malicious code already running in their origin. WebAuthn enrollment is un-attested and proves no legal identity or hardware model. Historical evidence verification grants no new authorization and establishes no trusted signing time.

## Verification

`npm test` currently runs 26 unit and integration checks. `npm run test:device` exercises real browser assertions with a virtual CTAP2 authenticator, persistent delivery keys, atomic local approval, cancellation, replay, storage failure, and concurrency. `npm run test:relay` exercises actual HTTP MCP, encrypted delivery, automatic opening, local PDF download, a failed notification, and retry with exactly one authentication. `npm run test:worker` runs after the relay build and checks the compiled Worker, fresh SQL migration, static routing, fail-closed enrollment, and global cleanup.

Timing output separates packet preparation/encryption, delivery to the open page, and signing/download. These loopback measurements omit model work, real network latency, app switching, and a person's authentication time. They support no subsecond end-to-end guarantee.

## Hosting and handoff

A Sites project is registered and retained in ignored local hosting state. It has no deployed version. The supported source helper could not connect to its Git hosting endpoint under this task's network restrictions. Reuse the existing project when publication is available.

See [remote setup and compatibility](REMOTE-SETUP.md) for the implementation contract and [the acceptance script](ACCEPTANCE.md) for the eventual user handoff. A working URL and tested cloud-agent connection are required before requesting user acceptance.
