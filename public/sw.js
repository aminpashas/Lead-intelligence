/**
 * Lead Intelligence service worker (Workstream D5 — staff web push).
 *
 * Registered on demand from the Settings → Notifications card when a user
 * enables push. Payloads are JSON from src/lib/notifications/web-push.ts:
 *   { title, body, url?, tag? }
 *
 * - push: show a notification (same-tag notifications replace each other).
 * - notificationclick: focus an existing app tab (navigating it to the
 *   conversation) or open a new window at the target URL.
 */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let payload = { title: 'Lead Intelligence', body: '', url: '/', tag: undefined }
  try {
    if (event.data) payload = { ...payload, ...event.data.json() }
  } catch {
    // Non-JSON payload — fall back to raw text as the body.
    try {
      payload.body = event.data ? event.data.text() : ''
    } catch {
      /* keep defaults */
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Lead Intelligence', {
      body: payload.body || '',
      tag: payload.tag,
      data: { url: payload.url || '/' },
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  const target = new URL(url, self.location.origin).href

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Prefer a tab already on the target URL, then any app tab we can
        // focus + navigate, then a fresh window.
        const exact = clientList.find((c) => c.url === target)
        if (exact && 'focus' in exact) return exact.focus()

        const anyClient = clientList.find((c) => 'focus' in c)
        if (anyClient) {
          return anyClient.focus().then((focused) => {
            if (focused && 'navigate' in focused) return focused.navigate(target)
            return focused
          })
        }
        return self.clients.openWindow(target)
      })
  )
})
