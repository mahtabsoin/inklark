import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const dist = path.resolve("dist");
// Only remove the literal build-output directory inside this project.
if (dist !== path.join(process.cwd(), "dist"))
  throw Error("Unexpected output directory.");
await rm(dist, { recursive: true, force: true });
await mkdir("dist/assets", { recursive: true });
for (const asset of ["icon.svg", "manifest.webmanifest"])
  await cp(`public/${asset}`, `dist/${asset}`);
for (const dir of ["cmaps", "standard_fonts", "wasm"])
  await cp(`node_modules/pdfjs-dist/${dir}`, `dist/pdf-assets/${dir}`, {
    recursive: true,
  });
const worker = await readFile(
  require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
);
const workerName = `pdf.worker-${createHash("sha256").update(worker).digest("hex").slice(0, 12)}.mjs`;
await writeFile(`dist/assets/${workerName}`, worker);
const result = await build({
  absWorkingDir: process.cwd(),
  entryPoints: [path.resolve("src/app.js"), path.resolve("src/sign-app.js")],
  tsconfigRaw: { compilerOptions: {} },
  bundle: true,
  format: "esm",
  outdir: "dist/assets",
  entryNames: "[name]-[hash]",
  assetNames: "[name]-[hash]",
  minify: true,
  target: "es2022",
  metafile: true,
  define: {
    "import.meta.env.BASE_URL": '"./"',
    "import.meta.env.PROD": "true",
  },
  plugins: [
    {
      name: "local-assets",
      setup(builder) {
        builder.onResolve({ filter: /\?url$/ }, (args) => ({
          path: args.path,
          namespace: "asset-url",
        }));
        builder.onLoad({ filter: /.*/, namespace: "asset-url" }, () => ({
          contents: `export default './assets/${workerName}';`,
          loader: "js",
        }));
        builder.onResolve({ filter: /^\/pdf-assets\// }, (args) => ({
          path: ".." + args.path,
          external: true,
        }));
        // Resolve through Node, then load exact files. This also works in restricted
        // workspaces where a native bundler cannot enumerate parent directories.
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (args.path.startsWith("node:"))
            return { path: args.path, external: true };
          const resolver = createRequire(
            args.importer
              ? path.resolve(args.importer)
              : new URL(import.meta.url),
          );
          const candidate = args.path.startsWith(".")
            ? path.resolve(args.resolveDir, args.path)
            : args.path;
          return {
            path: path
              .relative(process.cwd(), resolver.resolve(candidate))
              .replaceAll("\\", "/"),
            namespace: "local-file",
          };
        });
        builder.onLoad(
          { filter: /.*/, namespace: "local-file" },
          async (args) => ({
            contents: await readFile(path.resolve(args.path), "utf8"),
            loader: args.path.endsWith(".css")
              ? "css"
              : args.path.endsWith(".json")
                ? "json"
                : "js",
            resolveDir: path.dirname(path.resolve(args.path)),
          }),
        );
      },
    },
  ],
});
const outputs = Object.keys(result.metafile.outputs);
for (const [entry, target] of [
  ["src/app.js", "index.html"],
  ["src/sign-app.js", "sign.html"],
]) {
  const js = outputs.find((f) =>
    result.metafile.outputs[f].entryPoint?.endsWith(entry),
  );
  const css = result.metafile.outputs[js].cssBundle;
  let html = await readFile("index.html", "utf8");
  html = html.replace(
    '<script type="module" src="/src/app.js"></script>',
    `<link rel="stylesheet" href="./${css.replace(/^dist\//, "")}">\n  <script type="module" src="./${js.replace(/^dist\//, "")}"></script>`,
  );
  await writeFile(`dist/${target}`, html);
  console.log(`Built ${target}: ${js}.`);
}
