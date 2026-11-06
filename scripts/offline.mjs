import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
async function files(dir = "dist", base = "") {
  let out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )) {
    const relative = base + entry.name;
    if (entry.isDirectory())
      out.push(...(await files(`${dir}/${entry.name}`, `${relative}/`)));
    else out.push(relative);
  }
  return out;
}
const assets = (await files()).filter(
  (f) => !["sw.js", "offline-assets.json"].includes(f),
);
const hash = createHash("sha256");
for (const file of assets) hash.update(await readFile(`dist/${file}`));
const version = hash.digest("hex").slice(0, 16);
await writeFile("dist/offline-assets.json", JSON.stringify(assets));
await writeFile(
  "dist/sw.js",
  `const CACHE='fillsign-${version}';
self.addEventListener('install',event=>event.waitUntil((async()=>{const assets=await (await fetch('./offline-assets.json',{cache:'no-store'})).json();const cache=await caches.open(CACHE);await cache.addAll(assets.map(file=>new URL(file,self.registration.scope).href));})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('fillsign-')&&name!==CACHE)await caches.delete(name);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;const url=new URL(event.request.url);if(url.origin!==self.location.origin)return;event.respondWith((async()=>{const cache=await caches.open(CACHE);const cached=await cache.match(event.request,{ignoreSearch:false});if(cached)return cached;if(event.request.mode==='navigate')return await cache.match(new URL('index.html',self.registration.scope).href)||fetch(event.request);return fetch(event.request);})());});
`,
);
console.log(`Offline assets bundled: ${assets.length}. Build ${version}.`);
