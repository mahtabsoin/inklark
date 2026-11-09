# Acceptance script

Run this after the maintainer supplies a deployed HTTPS URL, one tested cloud-agent connection, and matching automated results. The current build has not reached that handoff.

1. Open the signing URL in your normal browser. Set up your name and device authentication once. Connect the named agent through its supported guided flow and share the device pairing instructions.
2. Give that agent a synthetic PDF containing an existing answer. Ask it to preserve that answer, fill a known field, and request your signature. Include one deliberately uncertain fact and confirm it asks before delivery.
3. Open the returned link on the paired device. The request should appear with its document title, signer, and proposed signature locations already prepared. Inspect the document if desired; no placement work or full-document review checkbox is required.
4. Choose **Sign this document** and complete device authentication once. Open the downloaded PDF and check the original answer, added information, and signature.
5. Ask the agent for status. It should report completion and have no signature image, private credential, approval secret, or completed PDF.
6. Repeat with a synthetic request and cancel authentication. Nothing should be approved. Retry, authenticate once, and confirm completion. Dismiss a separate request and confirm it remains unsigned. The automated failure test also interrupts completion notification, reloads the page, recovers the identical PDF, and retries status delivery with no additional authentication.

The release report must list its source commit, URL, exact agent and surface, automated results, and separate preparation, handoff, and signing measurements. State whether authentication was virtual or physical. Phone claims require physical-device evidence. An agent's reported output hash alone does not verify delivery or independently establish identity.

Automated regressions additionally exercise changed content, key substitution, expiry, replay, interrupted upload, lost responses, storage failure, and late-write cleanup. Avoid real financial, identity, or signature data while testing.
