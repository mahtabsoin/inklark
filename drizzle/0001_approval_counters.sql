CREATE TABLE approval_counters (owner TEXT NOT NULL, device_id TEXT NOT NULL, counter INTEGER NOT NULL, approval_hash TEXT NOT NULL, PRIMARY KEY(owner,device_id,counter));
--> statement-breakpoint
