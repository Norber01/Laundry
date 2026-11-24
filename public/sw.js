// Offline support: keeps a copy of the app on the phone so it opens without internet.
// - The app's own files: network first (so updates arrive), falling back to the saved copy
//   when there is no connection or the network is too slow.
// - Firebase code (gstatic.com, fixed version in the URL) and fonts: saved copy first.
// Data (orders, payments...) is not handled here: Firestore keeps its own offline copy and
// syncs changes when the connection returns.
const CACHE = "laundry-app-v1";
const FB = "https://www.gstatic.com/firebasejs/10.14.1";
const APP_FILES = ["./", "index.html", "app.js", "store.js", "styles.css", "firebase-config.js", "manifest.json", "icon.svg"];
const FIREBASE_FILES = [`${FB}/firebase-app.js`, `${FB}/firebase-auth.js`, `${FB}/firebase-firestore.js`];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_FILES);
    // Firebase files are best-effort here; they are also saved the first time the app loads them.
    await Promise.all(FIREBASE_FILES.map((u) => cache.add(new Request(u, { mode: "cors" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

const isFirebaseCode = (url) => url.href.startsWith(`${FB}/`);
const isFont = (url) => url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) event.respondWith(networkFirst(req));
  else if (isFirebaseCode(url) || isFont(url)) event.respondWith(cacheFirst(req));
  // Everything else (Firestore, sign-in, WhatsApp links...) goes straight to the network.
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  // Page loads may carry ?query strings; they all map to the same saved page.
  const key = req.mode === "navigate" ? "index.html" : req;
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch { /* offline: fall through to the saved copy */ }
  const saved = await cache.match(key, { ignoreSearch: true });
  if (saved) return saved;
  return network; // nothing saved yet: wait for the network after all
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(req);
  if (saved) return saved;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}
