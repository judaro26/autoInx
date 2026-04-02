/**
 * AutoInx Service Worker
 * Provides offline support and caches static assets for PWA.
 * Strategy: Cache-first for static assets, Network-first for API calls.
 */

const CACHE_NAME     = 'autoinx-v1';
const STATIC_ASSETS  = [
    '/',
    '/index.html',
    '/track-order.html',
    '/about.html',
    '/contact.html',
    '/terms.html',
    '/privacy.html',
    '/images/AutoInx logo.png',
    '/manifest.json',
];

// ── Install: cache static shell ──────────────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// ── Activate: clean old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys
                .filter(k => k !== CACHE_NAME)
                .map(k => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

// ── Fetch: serve from cache, fall back to network ────────────────────────────
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Always network-first for: API calls, Firebase, Netlify functions, CDN
    const networkFirst = [
        '/.netlify/functions/',
        'firestore.googleapis.com',
        'firebase.googleapis.com',
        'www.gstatic.com/firebasejs',
        'googletagmanager.com',
        'cdn.tailwindcss.com',
        'fonts.googleapis.com',
    ];
    if (networkFirst.some(p => event.request.url.includes(p))) {
        event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
        return;
    }

    // Cache-first for same-origin GET requests (HTML, images, CSS, JS)
    if (event.request.method === 'GET' && url.origin === self.location.origin) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                const networkFetch = fetch(event.request).then(response => {
                    if (response && response.status === 200 && response.type === 'basic') {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
                    return response;
                });
                return cached || networkFetch;
            })
        );
    }
});

// ── Background sync: retry failed cart saves ─────────────────────────────────
self.addEventListener('sync', event => {
    if (event.tag === 'sync-cart') {
        event.waitUntil(
            self.clients.matchAll().then(clients =>
                clients.forEach(client =>
                    client.postMessage({ type: 'SYNC_CART' })
                )
            )
        );
    }
});
