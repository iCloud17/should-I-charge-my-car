// service-worker.js - offline support for the static app shell.
//
// Update strategy (no manual version bumps needed):
//   - The cache name is intentionally STABLE. You never have to change it.
//   - Navigations (the HTML) are network-first, so a fresh deploy shows up on
//     the next load when online, falling back to cache when offline.
//   - Other assets (JS/CSS/JSON/icons) are stale-while-revalidate: served
//     instantly from cache and refreshed in the background for the next load.
// Change files freely; clients pick them up automatically.
const CACHE = "sicc";
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

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return; // pass through cross-origin

  // HTML shell: network-first so new deploys appear right away, cache as backup.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request).then((c) => c || caches.match("./index.html")))
    );
    return;
  }

  // Static assets: stale-while-revalidate (instant, self-updating).
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
