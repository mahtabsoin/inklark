# Security model

Inklark processes PDFs in the browser and exposes a restricted local preparation interface to agents. This project has not received an independent security audit. Use the documented controls and limitations to decide which documents to process.

## What is protected

- **Stored signatures:** signature names and PNG assets are encrypted together using AES-256-GCM. The key is derived from the vault password with PBKDF2-HMAC-SHA-256, 600,000 iterations, and a random 16-byte salt. Each save uses a fresh random 12-byte nonce. Only the encrypted envelope is written to localStorage. The derived key is non-extractable through the Web Crypto API. The password is not stored. An unlocked client can still access decrypted signatures.
- **Human approval:** agent requests carry signature placeholders. The agent API has no vault-read or sign operation. The browser renders the actual final bytes for review and requires a fresh approval checkbox before downloading a signature-bearing export. It rechecks the original's hash and edit snapshot at approval. This is application-level consent, not hardware-backed proof of human presence.
- **Local handoff:** the server binds to `127.0.0.1`, validates Host and Origin headers, rejects cross-origin requests, and uses random request secrets. The browser receives its one-use opening secret in a URL fragment. Tool results omit that secret. The browser removes the fragment after reading it. Requests expire after 30 minutes by default. The completion endpoint accepts a bounded receipt and no PDF bytes.
- **Cross-process preparation:** another local Inklark process can submit an unsigned request to the stable launcher using an endpoint that requires JSON and a custom header and rejects Origin-bearing requests. It can read redacted status using the random session ID. It cannot read a signature or apply one through these endpoints. Other programs running locally remain within the trusted-device threat model.
- **File access:** agent paths are restricted to the real path of `FILLSIGN_WORKSPACE`, including symlink resolution. Packet and CLI preview writes refuse to overwrite existing files. PDFs, request sizes, item counts, and vault imports have bounds. Request-file contents remain sensitive plaintext.
- **Untrusted content:** PDF JavaScript is not exposed as an executable viewer feature. PDF.js evaluation and XFA are disabled. Form fields and source labels are displayed as text, with escaped HTML. Local assets are bundled and a CSP restricts connections to the same origin. Supported PDFs with detected digital signatures or certification restrictions are rejected before editing.

## Boundaries

The optional protected-PDF helper runs pikepdf in a local subprocess. A bounded JSON request, including any PDF password, travels over stdin; output returns over stdout. The helper uses in-memory files and has a 45-second timeout. It has no document network calls and writes no temporary PDFs. The route requires the local app's exact Origin and an explicit operation header. It is excluded from MCP tools. The helper checks for existing PDF signatures and certification restrictions before saving an unencrypted copy. This protects the stored original; final downloads deliberately do not preserve the input PDF's password.

The local `/setup` endpoint supplies installation paths to build a copyable agent setup request. It contains no credentials or vault data. Cross-origin response reading is restricted by the same server controls. An agent receiving the copied request must still ask which document folder it may access.

A visual signature is copyable. Any person or agent who receives the signed PDF, an image of it, or screen access may copy the appearance. This release does not create certificate-backed signatures or prevent copying from exported documents.

An agent's report that it verified a fact is not independent verification. `source` values are untrusted labels. `sensitive`, `needsReview`, or a nonempty `question` triggers human acknowledgement, but the app cannot automatically identify every sensitive field that an agent failed to flag. Review the full document before signing consequential declarations.

Software with unrestricted control of the same browser or operating-system session can bypass application-level boundaries. A simple approval checkbox cannot establish human presence against browser automation or malware. Stronger isolation would require an independent privilege boundary, separate device, or authenticator-backed approval designed around the exact transaction.

The local server's health check identifies another running Inklark instance for convenience. It does not cryptographically authenticate that process. A malicious local process that controls the port is within the compromised-device threat model. Keep the OS and browser secure, restrict your agent's capabilities, and avoid unlocking the vault in an agent-controlled browser profile.

The hosting service supplies app code. A compromised host or malicious app update could intercept an unlocked vault. HTTPS and encryption at rest do not solve malicious client code. Self-host a reviewed build when this risk matters. Browser extensions and privileged developer tools are also part of the client trust boundary.

The completion receipt is an unauthenticated application report. It says the browser invoked a download and supplies an output hash. It is not proof of identity, legal intent, successful delivery, or cryptographic PDF signature validity.

## Storage and availability

The vault is local to an origin. Keep the local server port stable. A hosted copy, the development server, and another browser each have separate vault storage. Signature backups are encrypted and portable; manual transfers are the current cross-device mechanism.

PDFs and draft answers stay in memory unless the human saves a request or output. Application assets may be cached for offline loading; private documents are excluded from the cache list. Browser storage can be cleared or evicted. Keep vault backups and the password in safe places. Recovery is impossible if both the unlock secret and all usable copies are lost.

There is no automatic update check, telemetry, remote model call, or external runtime asset fetch in the browser app. Your agent client has its own network behavior and provider privacy terms. A user's chosen hosting service may log ordinary app requests and IP addresses.

## Experimental authenticated relay

The device-approval preview uses a separate WebAuthn flow described in [the release status](docs/BUILD-STATUS.md). Its request-bound approval replaces the editor's checkbox in that preview. The relay pins a public credential, verifies fresh user-verifying assertions, binds them to the encrypted delivery and exact output, and atomically records completion. The agent receives status and an output hash. This evidence is separate from a certificate-backed PDF signature and supplies no independently verified legal identity or trusted timestamp.

Approval credentials support ES256 with P-256 and RS256 with 2048 to 4096-bit RSA keys using exponent 65537. The algorithm is pinned at enrollment and determines verification; it is never guessed from an incoming signature. Existing profiles without an algorithm field retain their original ES256 interpretation. Both paths require the same origin, challenge, user-verification, expiry, and replay checks. RSA uses native Web Crypto verification with exact signature-length and key-parameter bounds.

The delivery adapter encrypts the document packet before upload for the device's pinned ECDH public key. The relay stores ciphertext chunks alongside routing metadata, public signer/device information, and approval evidence. Private authentication and delivery keys remain on the device. A non-extractable CryptoKey can still be used by code running in its browser origin. Client compromise remains in scope for the host and browser trust boundary described above.

Initial enrollment needs a server-enforced human admission boundary. A self-created un-attested credential proof cannot establish that boundary, and Origin is spoofable outside a browser. The Worker therefore disables enrollment until its gateway's browser-only authorization is verified. Existing device pinning prevents replacement through the enrollment operation. The loopback development server deliberately uses a fixed test identity and must remain local.

Requests expire after at most 30 minutes. Completion, dismissal, and expiry make payloads eligible for deletion. Conditional upload finalization and compensating deletion handle writes finishing after cleanup. A global sweep revisits closed requests and prunes metadata after a final sweep beyond the 24-hour window. The development server schedules sweeps; the Worker requires an independently activated and verified scheduler. Hosted retention is a release gate, and physical deletion can be delayed by failures. Request access still fails immediately on expiry.

The preview currently pairs one device and signer per owner. Device recovery, replacement, revocation, and private handwriting integration remain unfinished. A cloud provider receives any document information supplied through its own agent runtime. The relay's encryption does not change that provider relationship.

An approved output and its filename are cached locally under AES-GCM using a separate non-extractable recovery key. The encrypted copy, approval evidence, one-use request and nonce, and counter are committed atomically. Recovery verifies historical evidence and the exact output hash without creating a new authorization. It can download the same output or retry the original notification. The copy becomes unavailable after 30 minutes and is removed on the next app visit; returning to requests after successful notification removes it immediately. Pending notifications keep their copy for that window. The key remains usable by trusted code in the same origin. Approval evidence is retained separately, and browser storage loss still prevents output recovery.

Completion messages can arrive out of authentication order. The relay verifies each request's signature, binding, and expiry, atomically claims each positive counter once, rejects positive counters at or below the enrollment counter, and retains the maximum observed value. Credentials that consistently use zero rely on request binding and one-use state. Counter-claim records survive document-request cleanup. This policy permits reordered delivery and provides no guarantee of detecting cloned credentials. The [WebAuthn counter considerations](https://www.w3.org/TR/webauthn-3/#sctn-sign-counter) identify response ordering as one possible cause of a non-increasing received counter.

## Reporting

Report vulnerabilities privately to the repository maintainer through GitHub private vulnerability reporting when enabled. Do not include real documents, signature assets, vault passwords, or personal identifiers in public issues. Use synthetic fixtures for reproduction.
