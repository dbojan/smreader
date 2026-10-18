// SM Reader - sw.js
// last modified (utc): 2026-10-10-21-24-31
// instructions: on modify, update string.
// scope-safe (2026-10-07-12-54-28): the cache name has a prefix, and only caches with it (or the plain stamp names used before)
// are ever deleted: other apps on the same address (username.github.io) keep their caches. CACHE_PREFIX = OWN_CACHE_PREFIX in js/app.js.
const CACHE_PREFIX = 'sm-reader-'
const CACHE = CACHE_PREFIX + '2026-10-10-21-24-31'
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/dict-worker.js',
  './js/foliate-js/view.js',
  './js/foliate-js/epub.js',
  './js/foliate-js/epubcfi.js',
  './js/foliate-js/progress.js',
  './js/foliate-js/overlayer.js',
  './js/foliate-js/text-walker.js',
  './js/foliate-js/paginator.js',
  './js/foliate-js/vendor/zip.js',
  './js/foliate-js/vendor/fflate.js',
  './fonts/Jost.ttf',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
]

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)))
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys
      .filter(k => k !== CACHE && (k.startsWith(CACHE_PREFIX) || /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(k)))
      .map(k => caches.delete(k))))
  )
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return
  // dictionary data (dict/) is imported once into IndexedDB, so it is not cached here a second time (dictionary-bundled-import)
  if (new URL(e.request.url).pathname.includes('/dict/')) return
  e.respondWith(
    caches.match(e.request, { cacheName: CACHE }).then(cached => cached || fetch(e.request).then(res => {
      const copy = res.clone()
      caches.open(CACHE).then(c => c.put(e.request, copy))
      return res
    }).catch(() => cached))
  )
})
