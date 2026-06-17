/* Offline cache for the Wanderlist app shell. */
var CACHE = 'wanderlist-v3';
var ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/icon-maskable.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  // Only handle same-origin GETs (the app shell). Anything else hits the network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Network-first for the page/code so fixes ship immediately and the HTML and
  // JS never get stuck on mismatched cached versions. Fall back to cache offline.
  var isShell = req.mode === 'navigate' ||
    /\.(html|js|css|webmanifest)$/.test(new URL(req.url).pathname);

  if (isShell) {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req, { ignoreSearch: true })
          .then(function (hit) { return hit || caches.match('./index.html'); });
      })
    );
    return;
  }

  // Cache-first for everything else (icons, etc.).
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () { return caches.match('./index.html'); });
    })
  );
});
