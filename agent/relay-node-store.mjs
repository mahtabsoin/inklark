import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { RelayStore, SCHEMA } from "./relay-store.mjs";

export async function nodeRelayStore(directory) {
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true });
  const db = new DatabaseSync(path.join(root, "relay.sqlite"));
  for (const sql of SCHEMA) db.exec(sql);
  const wrap = (statement) => ({
    first: async () => statement.get() || null,
    all: async () => ({ results: statement.all() }),
    run: async () => ({ meta: { changes: Number(statement.run().changes) } }),
  });
  const database = {
    prepare: (sql) => ({
      bind: (...values) => {
        const statement = db.prepare(sql);
        return {
          ...wrap({
            get: () => statement.get(...values),
            all: () => statement.all(...values),
            run: () => statement.run(...values),
          }),
          _sql: sql,
          _values: values,
        };
      },
    }),
    batch: async (statements) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((s) => ({
          meta: {
            changes: Number(db.prepare(s._sql).run(...s._values).changes),
          },
        }));
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  function file(key) {
    if (!/^[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{43}\/\d{1,4}$/.test(key))
      throw Error("Invalid ciphertext storage key.");
    const destination = path.resolve(root, "chunks", key);
    if (!destination.startsWith(root + path.sep))
      throw Error("Invalid storage destination.");
    return destination;
  }
  const bucket = {
    put: async (key, value) => {
      const destination = file(key);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, value);
    },
    get: async (key) => {
      try {
        const value = await readFile(file(key), "utf8");
        return { text: async () => value };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    delete: async (key) => {
      if (Array.isArray(key)) {
        await Promise.all(key.map((item) => bucket.delete(item)));
        return;
      }
      try {
        await unlink(file(key));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
  };
  const store = new RelayStore(database, bucket);
  store.close = () => db.close();
  return store;
}
