/* Service worker: makes the app installable and usable with no signal.
 *
 * The shell and the route data are cached up front, so every district store's
 * route, times and directions work offline. Map tiles are cached as you view
 * them (bounded), and live re-routing needs a connection. */
'use strict';

var VERSION = 'pbc-v2';
var SHELL = VERSION + '-shell';
var TILES = VERSION + '-tiles';
var ROUTES = VERSION + '-routes';
var TILE_LIMIT = 600;
var ROUTE_LIMIT = 200;

var SHELL_FILES = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'vendor/leaflet.js',
  'vendor/leaflet.css',
  'vendor/images/marker-icon.png',
  'vendor/images/marker-icon-2x.png',
  'vendor/images/marker-shadow.png',
  'vendor/images/layers.png',
  'vendor/images/layers-2x.png',
  'data/stores.json',
  'data/routes-index.json',
  'profiles/florida-balanced.brf',
  'profiles/florida-calm.brf',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL)
      .then(function (c) { return c.addAll(SHELL_FILES); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL && k !== TILES && k !== ROUTES) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function trimCache(name, max) {
  caches.open(name).then(function (c) {
    c.keys().then(function (keys) {
      if (keys.length <= max) return;
      for (var i = 0; i < keys.length - max; i++) c.delete(keys[i]);
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // Map tiles: serve from cache, otherwise fetch and keep a bounded number.
  if (/tile\.openstreetmap\.org$/.test(url.hostname)) {
    e.respondWith(
      caches.open(TILES).then(function (c) {
        return c.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (res.ok) { c.put(req, res.clone()); trimCache(TILES, TILE_LIMIT); }
            return res;
          }).catch(function () {
            return new Response('', { status: 504, statusText: 'offline' });
          });
        });
      })
    );
    return;
  }

  // Per-store route files: keep each one after its first view, so a store you
  // have opened stays available with no signal.
  if (url.origin === location.origin && /\/data\/routes\//.test(url.pathname)) {
    e.respondWith(
      caches.open(ROUTES).then(function (c) {
        return c.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (res.ok) { c.put(req, res.clone()); trimCache(ROUTES, ROUTE_LIMIT); }
            return res;
          }).catch(function () {
            return new Response('', { status: 504, statusText: 'offline' });
          });
        });
      })
    );
    return;
  }

  // Routing API is always live — never served stale.
  if (url.hostname === 'brouter.de') return;

  // Everything else: cache first, revalidating in the background.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res.ok) {
            var copy = res.clone();
            caches.open(SHELL).then(function (c) { c.put(req, copy); });
          }
          return res;
        }).catch(function () { return hit; });
        return hit || net;
      })
    );
  }
});
