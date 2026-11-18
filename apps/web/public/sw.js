// Rushr service worker: makes the terminal installable and quick to open, without ever serving stale market
// data. It caches only what can't go stale:
//   - /_next/static/* (content-hashed build files): cache first;
//   - icons and art: served from cache, refreshed in the background;
//   - pages: always from the network; offline, a small "You're offline" page instead.
// Prices, trades and everything on api.rushr.trade (another origin) never pass through here.
const VERSION = 'v1';
const SHELL = `rushr-shell-${VERSION}`;
const ASSETS = `rushr-assets-${VERSION}`;
// Cloudflare serves public/offline.html at /offline (it redirects the .html URL there).
const OFFLINE = '/offline';
const PRECACHE = [OFFLINE, '/pwa/icon-192.png', '/pwa/icon-512.png', '/logo-mark.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isStaticBuild = (url) => url.pathname.startsWith('/_next/static/');
const isArt = (url) => /^\/(pwa|art|brand|card)\//.test(url.pathname) || /^\/logo[\w-]*\.png$/.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
    return;
  }
  if (isStaticBuild(url)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(ASSETS).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }
  if (isArt(url)) {
    event.respondWith(
      caches.open(ASSETS).then((c) =>
        c.match(req).then((hit) => {
          const fresh = fetch(req)
            .then((res) => {
              if (res.ok) c.put(req, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || fresh;
        }),
      ),
    );
  }
  // Everything else goes straight to the network, untouched.
});
