// The relay stores routing metadata and public authentication keys in SQL.
// Ciphertext chunks live separately in an encrypted-payload bucket.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS devices (owner TEXT PRIMARY KEY, device_id TEXT NOT NULL, public_json TEXT NOT NULL, registration_hash TEXT NOT NULL, counter INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS requests (owner TEXT NOT NULL, request_id TEXT NOT NULL, device_id TEXT NOT NULL, manifest_json TEXT NOT NULL, delivery_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, approval_hash TEXT, output_hash TEXT, approval_json TEXT, completed_at INTEGER, payload_deleted INTEGER NOT NULL DEFAULT 0, last_cleaned_at INTEGER, PRIMARY KEY(owner,request_id))`,
  `CREATE TABLE IF NOT EXISTS chunks (owner TEXT NOT NULL, request_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, PRIMARY KEY(owner,request_id,chunk_index))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS approval_once ON requests(owner,approval_hash) WHERE approval_hash IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS cleanup_queue ON requests(payload_deleted,last_cleaned_at,expires_at)`,
];

export class RelayStore {
  constructor(db, bucket) {
    this.db = db;
    this.bucket = bucket;
  }
  statement(sql, ...values) {
    return this.db.prepare(sql).bind(...values);
  }
  async device(owner) {
    const row = await this.statement(
      "SELECT * FROM devices WHERE owner=?",
      owner,
    ).first();
    return row
      ? {
          ...JSON.parse(row.public_json),
          credential: {
            ...JSON.parse(row.public_json).credential,
            counter: row.counter,
          },
          registrationHash: row.registration_hash,
        }
      : null;
  }
  async register(owner, device, registrationHash) {
    const result = await this.statement(
      "INSERT OR IGNORE INTO devices(owner,device_id,public_json,registration_hash,counter) VALUES(?,?,?,?,?)",
      owner,
      device.deviceId,
      JSON.stringify(device),
      registrationHash,
      device.credential.counter,
    ).run();
    return result.meta.changes === 1;
  }
  async request(owner, id) {
    const row = await this.statement(
      "SELECT * FROM requests WHERE owner=? AND request_id=?",
      owner,
      id,
    ).first();
    return row ? { ...row, manifest: JSON.parse(row.manifest_json) } : null;
  }
  async start(owner, manifest, hash, now) {
    const result = await this.statement(
      `INSERT OR IGNORE INTO requests(owner,request_id,device_id,manifest_json,delivery_hash,expires_at,state)
      SELECT ?,?,?,?,?,?,'uploading' WHERE (SELECT COUNT(*) FROM requests WHERE owner=? AND state IN ('uploading','pending') AND expires_at>?)<5`,
      owner,
      manifest.route.requestId,
      manifest.route.deviceId,
      JSON.stringify(manifest),
      hash,
      manifest.route.expiresAt,
      owner,
      now,
    ).run();
    return result.meta.changes === 1;
  }
  async chunk(owner, id, index, now) {
    return this.statement(
      `INSERT OR IGNORE INTO chunks(owner,request_id,chunk_index)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM requests WHERE owner=? AND request_id=? AND state='uploading' AND expires_at>?)`,
      owner,
      id,
      index,
      owner,
      id,
      now,
    ).run();
  }
  async chunkCount(owner, id) {
    return (
      await this.statement(
        "SELECT COUNT(*) AS n FROM chunks WHERE owner=? AND request_id=?",
        owner,
        id,
      ).first()
    ).n;
  }
  async finish(owner, id, now) {
    const result = await this.statement(
      "UPDATE requests SET state='pending' WHERE owner=? AND request_id=? AND state='uploading' AND expires_at>?",
      owner,
      id,
      now,
    ).run();
    return result.meta.changes === 1;
  }
  async inbox(owner, deviceId, now) {
    const rows = await this.statement(
      "SELECT * FROM requests WHERE owner=? AND device_id=? AND state='pending' AND expires_at>? ORDER BY rowid LIMIT 5",
      owner,
      deviceId,
      now,
    ).all();
    return rows.results.map((row) => ({
      ...row,
      manifest: JSON.parse(row.manifest_json),
    }));
  }
  async complete(
    owner,
    request,
    device,
    record,
    approvalHash,
    verifiedCounter,
    now,
  ) {
    const results = await this.db.batch([
      this.statement(
        `UPDATE requests SET state='completed',approval_hash=?,output_hash=?,approval_json=?,completed_at=?
        WHERE owner=? AND request_id=? AND state='pending' AND expires_at>?
        AND EXISTS(SELECT 1 FROM devices WHERE owner=? AND counter=?)`,
        approvalHash,
        record.intent.outputHash,
        JSON.stringify(record),
        now,
        owner,
        request.request_id,
        now,
        owner,
        device.credential.counter,
      ),
      this.statement(
        `UPDATE devices SET counter=MAX(counter,?) WHERE owner=? AND counter=?
        AND EXISTS(SELECT 1 FROM requests WHERE owner=? AND request_id=? AND approval_hash=?)`,
        verifiedCounter,
        owner,
        device.credential.counter,
        owner,
        request.request_id,
        approvalHash,
      ),
    ]);
    return results[0].meta.changes === 1;
  }
  async cleanupCandidates(owner, now, limit = 5) {
    const rows = await this.statement(
      `SELECT * FROM requests WHERE (? IS NULL OR owner=?)
      AND (expires_at<=? OR state IN ('completed','cancelled'))
      AND (payload_deleted=0 OR last_cleaned_at<=?)
      ORDER BY COALESCE(last_cleaned_at,0),expires_at LIMIT ?`,
      owner,
      owner,
      now,
      now - 5 * 60000,
      limit,
    ).all();
    return rows.results.map((row) => ({
      ...row,
      manifest: JSON.parse(row.manifest_json),
    }));
  }
  async markDeleted(owner, id, now) {
    await this.db.batch([
      this.statement(
        "UPDATE requests SET payload_deleted=1,last_cleaned_at=?,state=CASE WHEN state IN ('pending','uploading') AND expires_at<=? THEN 'expired' ELSE state END WHERE owner=? AND request_id=?",
        now,
        now,
        owner,
        id,
      ),
      this.statement(
        "DELETE FROM chunks WHERE owner=? AND request_id=?",
        owner,
        id,
      ),
    ]);
  }
  async prune(owner, now) {
    await this.statement(
      "DELETE FROM requests WHERE (? IS NULL OR owner=?) AND payload_deleted=1 AND expires_at<? AND last_cleaned_at>=expires_at+?",
      owner,
      owner,
      now - 24 * 60 * 60000,
      24 * 60 * 60000,
    ).run();
  }
  async cancel(owner, id) {
    const result = await this.statement(
      "UPDATE requests SET state='cancelled' WHERE owner=? AND request_id=? AND state IN ('pending','uploading')",
      owner,
      id,
    ).run();
    return result.meta.changes === 1;
  }
}
