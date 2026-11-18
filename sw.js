const CACHE = 'calorie-v20261118-2';
const PRECACHE = ['/', '/index.html', '/style.css', '/app-ui.js', '/sync-shim.js', '/sync.js', '/menu.html', '/add.html', '/products.html', '/products-list.html', '/recipes.html', '/weight.html', '/profile.html', '/workouts.html', '/dishes.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
