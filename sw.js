/* Simple offline cache for the app shell. */
var CACHE = '75hard-v137';
var ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/config.js',
  './assets/indian-foods.js',
  './js/app.js',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/icon-180.png',
  './assets/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// The app shell (HTML + the code/style/config that changes on every release)
// is served STALE-WHILE-REVALIDATE: respond from cache instantly (fast +
// offline), but always fetch a fresh copy in the background and update the
// cache, so the next load is current. Combined with a CACHE bump every release
// (which installs a new worker) and the client's controllerchange auto-reload,
// updates now land on their own instead of users getting stuck on stale builds
// — the old pure cache-first strategy never refreshed the shell.
function isShell(url, req) {
  if (req.mode === 'navigate') return true;
  var p = url.pathname;
  return p === '/' || p.charAt(p.length - 1) === '/' || /(?:^|\/)(index\.html)$/.test(p) ||
    /\/js\/app\.js$/.test(p) || /\/js\/config\.js$/.test(p) ||
    /\/css\/styles\.css$/.test(p) || /\/manifest\.webmanifest$/.test(p);
}
self.addEventListener('fetch', function (e) {
  var req = e.request;
  // Only handle same-origin GETs. Let API calls to Apps Script and food-database
  // lookups (Open Food Facts) always go straight to the network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  var url = new URL(req.url);
  if (isShell(url, req)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        var fresh = fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return res;
        }).catch(function () { return hit || caches.match('./index.html'); });
        return hit || fresh;   // instant cache, revalidate in the background
      })
    );
  } else {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return res;
        }).catch(function () { return caches.match('./index.html'); });
      })
    );
  }
});
