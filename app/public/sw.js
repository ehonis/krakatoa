/*
 * Krakatoa's service worker. Deliberately minimal: it caches the SHELL so the app
 * opens in a basement or a supermarket aisle, and never caches /api — a cached
 * food log that disagrees with the server is worse than a spinner.
 */
const SHELL = 'krakatoa-shell-v1'

self.addEventListener('install', (e) => {
  self.skipWaiting()
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['./', './index.html']).catch(() => {})))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET') return
  if (url.pathname.startsWith('/api/')) return // always live

  // Network first, cache as a fallback: the app updates when it can and still
  // opens when it cannot.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone()
          caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {})
        }
        return res
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  )
})
