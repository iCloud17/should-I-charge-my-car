// service-worker.js - offline support for the static app shell.
//
// Update strategy (no manual version bumps needed):
//   - The cache name is intentionally STABLE. You never have to change it.
//   - Everything is NETWORK-FIRST: when online, each load fetches the latest
//     files, so a fresh deploy shows up on the very next load (no "stale until
//     the following visit" lag). Successful responses refresh the cache as they
//     go.
//   - It falls back to cache on failure OR after a short timeout, so the app
//     still loads instantly on weak charger signal or fully offline.
// Change files freely; clients get them on their next online load.
const CACHE = "sicc";
const NET_TIMEOUT_MS = 2500; // weak signal: stop waiting and serve cache
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/main.js",
  "./js/calc.js",
  "./js/units.js",
  "./js/storage.js",
  "./js/cars.js",
  "./js/ui.js",
  "./js/theme.js",
  "./data/phevs.json",
  "./icons/icon.svg",
];

self.addEventListener("install", (event) => {
  // Fetch each asset fresh from the network (cache: "reload") so a previous
  // service worker can't poison the new cache with stale files during install.
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  // Drop any other caches, including older versioned ones (sicc-v*).
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Network-first with an offline/slow fallback to cache. Guarantees the latest
// deploy whenever the network answers in time, while staying instant + usable
// on weak charger signal or offline. A slow-but-eventually-successful fetch
// still refreshes the cache for the next load.
function networkFirst(request) {
  return new Promise((resolve) => {
    const serveCache = () =>
      caches.match(request).then((cached) =>
        resolve(cached || (request.mode === "navigate" ? caches.match("./index.html") : Response.error()))
      );
    const timer = setTimeout(serveCache, NET_TIMEOUT_MS);
    fetch(request)
      .then((res) => {
        clearTimeout(timer);
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        resolve(res);
      })
      .catch(() => { clearTimeout(timer); serveCache(); });
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return; // pass through cross-origin
  event.respondWith(networkFirst(request));
});
