# Design decisions

Inklark reduces the manual work of completing a PDF while keeping the final signing decision with a person. It is a small local application with an agent preparation interface. The initial release has no subscription, paid signing dependency, or document-processing service.

## Separate preparation from signing

An agent can inspect a document, map fields, fill reliable answers, and mark signature locations. It can use the information and sources the user has authorized in its own environment. Inklark does not build another personal-memory system or model integration.

The browser owns saved signatures and the final export. The agent interface accepts placeholders and receives status. This limits what the integration exposes even if an agent client automatically approves tool calls. It cannot prevent an agent with unrestricted operating-system or browser control from bypassing those boundaries. Stronger isolation would require a different privilege or device boundary.

## Model a careful executive assistant

Routine answers should flow from reliable context without repetitive questions. Ambiguous or conflicting information calls for focused clarification. Sensitive facts require an appropriate source or direct confirmation. Consent and new declarations require a human decision.

The request format carries source labels, questions, and review flags. Sensitive and uncertain answers remain blocked until the human checks them. A source label is an agent-reported claim. It is not independent verification, and the interface does not present a confidence score as proof.

The trust policy is shared between an agent guide and application controls. The guide sets expectations for deciding which facts to use. The application enforces the review flags it receives and approval of signature export. It cannot infer every missing sensitivity flag or establish whether an external source is accurate.

## Render the result before approval

The review displays the actual exported PDF bytes, with signature placement already rendered inside the human browser. Approval downloads those same bytes after checking that the original PDF and edit snapshot still match the reviewed version. The review opens near the first signature, with every page available.

This avoids relying only on a separate DOM overlay whose appearance may differ from the exported PDF. It also exposes font sizing and form appearance changes before the user saves the file. The agent can render unsigned before and after previews separately.

## Store signatures locally

Names and signature images are encrypted together in a password-protected vault. The browser keeps the unlocked key and signature data for the session, then locks after inactivity. Backups are encrypted and portable. Documents remain session-only unless the human deliberately saves a draft or output.

This provides a useful first release without operating a synchronization service. The cost is manual transfer between devices and no password recovery. A remote encrypted vault would add device enrollment, recovery, storage availability, update integrity, and ongoing operational work. Those concerns are deferred until the core workflow proves useful.

## Use ordinary visual signatures first

The initial release stores and applies drawn, typed, or uploaded signature appearances. It clearly labels these as visual signatures. It does not claim certificate-backed integrity, identity verification, or a legally authenticated audit log.

Visible signatures can be copied from any finished document. Keeping the vault asset secret does not prevent copying from an output. By default the agent tools receive a completion receipt and the human receives the signed file. Future certificate support would protect the private signing key while allowing recipients to verify the signed content, but would require certificate and trust management.

## Keep the human interface small

The document occupies the main workspace. A compact toolbar provides text, checks, dates, and signature placement. Existing form fields are directly editable. A sidebar holds signatures and details about the selected answer. The phone layout uses the same document engine and opens editing details above the bottom edge when needed.

The main flow is open, prepare, review, and download. Existing agent clients handle natural-language instructions and source access. There is no additional chat interface inside the PDF editor.

The speed target is a short interaction for familiar forms with reliable answers. Processing time, model latency, and human review time are distinct. The app does not promise that every scanned document or consequential declaration can be completed safely in a fixed number of seconds.

## Distribute a static application

The browser bundle is self-contained and uses same-origin assets. A static HTTPS host can serve it, and a service worker caches application assets for offline loading. Private PDFs and vault data are excluded from that cache list. The local Node launcher provides the agent handoff on a stable loopback origin.

The build uses esbuild without exposing a bundler development server. Runtime dependencies are PDF parsing and rendering libraries. The source includes their licenses and pinned dependency versions. A hosted app still trusts the code delivered by its host, and all clients still need secure updates and a secure device.

## Fail clearly on unsupported files

The release supports standard form fields and manual overlays. It rejects detected existing digital signatures, certification restrictions, and XFA forms. It does not silently rewrite a digitally signed original. Unsupported characters and text that does not fit its rectangle produce explicit errors.

An optional local pikepdf helper handles encrypted files and some compatibility failures. It decrypts and rewrites the document in memory, preserving native form fields. The browser asks for a PDF password when needed and makes clear that output copies are unencrypted. This adds an optional Python dependency to the local launcher; the hosted static app does not gain that capability. A future browser-native decryption engine could remove that distinction. Simply ignoring the encryption flag in pdf-lib would not decrypt the content and is deliberately avoided.

OCR, arbitrary PDF content editing, automatic online synchronization, and certificate signing are separate future capabilities. Mobile viewport testing checks layout and interactions; physical iPhone and Android testing is still needed before claiming full device compatibility.
