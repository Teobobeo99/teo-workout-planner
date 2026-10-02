// Service worker: lets the app work offline by keeping a copy of every app file.
//
// Strategy = "stale-while-revalidate": answer instantly from the saved copy,
// and quietly download a fresh copy in the background for next time.
// (So after you edit the code, reload twice to see the change. Or bump CACHE_NAME.)
//
// The exercise pictures (images/, about 15 MB) live in their own cache that is NOT
// renamed on each release, so an app update doesn't download them all again.

const CACHE_NAME = 'workout-planner-v8';
const IMAGE_CACHE = 'workout-planner-images-v1';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './data/exercises.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// Install: save all files the first time, then (best effort) all exercise pictures.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(FILES);
    try {
      const images = await caches.open(IMAGE_CACHE);
      const list = await (await fetch('data/exercises.json')).json();
      const urls = list.flatMap((e) => e.images.map((file) => 'images/' + encodeURI(file)));
      // One missing picture must not stop the app from installing, so each add is allowed to fail.
      await Promise.all(urls.map(async (url) => {
        if (!(await images.match(url))) await images.add(url).catch(() => {});
      }));
    } catch (err) { /* offline or no data file: pictures are saved later, as they are viewed */ }
  })());
  self.skipWaiting();
});

// Activate: delete caches from older versions (but keep the pictures).
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME && n !== IMAGE_CACHE).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: serve from cache, refresh in background.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Exercise pictures never change: use the saved copy, else download once and keep it.
  if (new URL(event.request.url).pathname.includes('/images/')) {
    event.respondWith(caches.open(IMAGE_CACHE).then(async (cache) => {
      const saved = await cache.match(event.request);
      if (saved) return saved;
      const response = await fetch(event.request);
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    }));
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => cached); // offline: fall back to the saved copy
      return cached || network;
    })
  );
});
