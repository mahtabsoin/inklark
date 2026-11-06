CREATE TABLE devices (owner TEXT PRIMARY KEY, device_id TEXT NOT NULL, public_json TEXT NOT NULL, registration_hash TEXT NOT NULL, counter INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE requests (owner TEXT NOT NULL, request_id TEXT NOT NULL, device_id TEXT NOT NULL, manifest_json TEXT NOT NULL, delivery_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, approval_hash TEXT, output_hash TEXT, approval_json TEXT, completed_at INTEGER, payload_deleted INTEGER NOT NULL DEFAULT 0, last_cleaned_at INTEGER, PRIMARY KEY(owner,request_id));
--> statement-breakpoint
CREATE TABLE chunks (owner TEXT NOT NULL, request_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, PRIMARY KEY(owner,request_id,chunk_index));
--> statement-breakpoint
CREATE UNIQUE INDEX approval_once ON requests(owner,approval_hash) WHERE approval_hash IS NOT NULL;
--> statement-breakpoint
CREATE INDEX cleanup_queue ON requests(payload_deleted,last_cleaned_at,expires_at);
--> statement-breakpoint