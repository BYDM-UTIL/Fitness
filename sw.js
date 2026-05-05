// ============================================================
//  Service Worker – Fitness Tracker PWA
//  אסטרטגיה: Cache-First עם עדכון ברקע
// ============================================================

const CACHE_NAME = 'fitness-tracker-v1';

// קבצים לשמירה במטמון
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
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

  // דלג על בקשות שאינן לאתר שלנו
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // הגש מהמטמון ועדכן ברקע (stale-while-revalidate)
        fetch(event.request)
          .then(response => {
            if (response && response.status === 200) {
              caches.open(CACHE_NAME).then(cache =>
                cache.put(event.request, response.clone())
              );
            }
          })
          .catch(() => {}); // שגיאת רשת – לא קריטי

        return cached;
      }

      // אין במטמון – משיג מהרשת ושומר
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        caches.open(CACHE_NAME).then(cache =>
          cache.put(event.request, response.clone())
        );

        return response;
      });
    })
  );
});

// ===== Push Notifications (הכנה לעתיד – FCM) =====
// TODO: לחבר Firebase Cloud Messaging בעתיד
// self.addEventListener('push', event => {
//   const data = event.data?.json() ?? {};
//   event.waitUntil(
//     self.registration.showNotification(data.title || 'כושר', {
//       body: data.body || 'תזכורת יומית 🏋️',
//       icon: './icons/icon.svg',
//       badge: './icons/icon.svg',
//       dir: 'rtl',
//       lang: 'he',
//     })
//   );
// });

// self.addEventListener('notificationclick', event => {
//   event.notification.close();
//   event.waitUntil(clients.openWindow('/'));
// });
