// ============================================================
//  Service Worker – Fitness Tracker PWA
//  אסטרטגיה: Network-First לקבצי אפליקציה, Cache-First לאייקונים
// ============================================================

const CACHE_NAME = 'fitness-tracker-v5';

// קבצים לשמירה במטמון
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];

// ===== Install =====
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching assets');
      return cache.addAll(ASSETS);
    })
  );
  // ממתין ולא ממתין לסגירת tabs ישנים
  self.skipWaiting();
});

// ===== Activate =====
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    )
  );
  // השתלט מיידית על כל הלקוחות
  self.clients.claim();
});

// ===== Fetch =====
self.addEventListener('fetch', event => {
  // רק GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // לא נשמור API במטמון כדי למנוע נתונים ישנים
  if (url.pathname.startsWith('/api/')) return;

  // דלג על בקשות שאינן לאתר שלנו
  if (url.origin !== self.location.origin) return;

  const isAppShellRequest =
    event.request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.endsWith('/index.html') ||
    url.pathname.endsWith('/app.js') ||
    url.pathname.endsWith('/styles.css') ||
    url.pathname.endsWith('/firebase-config.js') ||
    url.pathname.endsWith('/manifest.webmanifest');

  if (isAppShellRequest) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200 && response.type === 'basic') {
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
        return response;
      });
    })
  );
});
