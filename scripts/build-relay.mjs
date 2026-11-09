import { build } from "esbuild";
import { mkdir, readdir, rename, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

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
// Source migrations are immutable. Building validates them without rewriting
// the schema history or journal. Sites supplies deployment storage identifiers.
const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
if (journal.dialect !== "sqlite" || !Array.isArray(journal.entries) || !journal.entries.length)
  throw Error("The relay migration journal is unavailable.");
for (const [index, entry] of journal.entries.entries()) {
  if (entry.idx !== index || !/^[0-9]{4}_[a-z0-9_]+$/.test(entry.tag))
    throw Error("Invalid relay migration journal entry.");
  if (!(await readFile(`drizzle/${entry.tag}.sql`, "utf8")).trim())
    throw Error("A relay migration is empty.");
}
console.log(
  "Built the relay Worker and browser assets. Runtime identity, bindings, and deployment still require verification.",
);
