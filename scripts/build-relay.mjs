import { build } from "esbuild";
import { mkdir, readdir, rename, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { SCHEMA } from "../agent/relay-store.mjs";

// Run after build.mjs: the editor and approval UI share the same static assets.
const contents = await readdir("dist");
if (contents.includes("client") || contents.includes("server"))
  throw Error("Run the browser build before building the relay.");
await mkdir("dist/client", { recursive: true });
for (const name of contents)
  await rename(`dist/${name}`, `dist/client/${name}`);
await mkdir("dist/server", { recursive: true });
await build({
  entryPoints: ["agent/relay-worker.mjs"],
  outfile: "dist/server/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  tsconfigRaw: { compilerOptions: {} },
  plugins: [{
    name: "relay-source",
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => ({
        path: path.resolve(args.resolveDir || process.cwd(), args.path),
        namespace: "relay-source",
      }));
      builder.onLoad({ filter: /.*/, namespace: "relay-source" }, async (args) => ({
        contents: await readFile(args.path, "utf8"), loader: "js", resolveDir: path.dirname(args.path),
      }));
    },
  }],
});
await writeFile(
  "dist/server/wrangler.json",
  JSON.stringify(
    {
      name: "inklark",
      main: "index.js",
      compatibility_date: "2026-11-01",
      assets: {
        directory: "../client",
        binding: "ASSETS",
        run_worker_first: true,
      },
      d1_databases: [
        {
          binding: "DB",
          database_name: "inklark",
          database_id: "00000000-0000-4000-8000-000000000000",
        },
      ],
      r2_buckets: [
        { binding: "BUCKET", bucket_name: "inklark-encrypted-requests" },
      ],
      triggers: { crons: ["*/5 * * * *"] },
    },
    null,
    2,
  ),
);
// These schema-only migrations are for a new deployment. Applied migrations
// remain immutable. Sites provisions real database and bucket identifiers.
await mkdir("drizzle/meta", { recursive: true });
const migration = "drizzle/0000_relay.sql";
const sql = SCHEMA.map(
  (statement) =>
    statement.replace("IF NOT EXISTS ", "") + ";\n--> statement-breakpoint",
).join("\n");
let existing = null;
try {
  existing = await readFile(migration, "utf8");
} catch {}
if (existing !== null && existing !== sql)
  throw Error(
    "Append a migration instead of changing an existing schema migration.",
  );
if (existing === null) await writeFile(migration, sql, { flag: "wx" });
const journalPath = "drizzle/meta/_journal.json";
let journal;
try { journal = JSON.parse(await readFile(journalPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (journal && (journal.dialect !== "sqlite" || !journal.entries.some((entry) => entry.tag === "0000_relay")))
  throw Error("Existing migration journal does not include the relay migration.");
if (!journal) await writeFile(
  journalPath,
  JSON.stringify(
    {
      version: "7",
      dialect: "sqlite",
      entries: [
        {
          idx: 0,
          version: "6",
          when: 1794000000000,
          tag: "0000_relay",
          breakpoints: true,
        },
      ],
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(
  "Built the relay Worker and browser assets. Runtime identity, bindings, and deployment still require verification.",
);
