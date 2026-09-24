'use strict';

// プッシュ通知を受け取って表示する（画面を閉じていても動く）

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* 形式が違う通知は既定の文言で表示 */
  }
  event.waitUntil(self.registration.showNotification(data.title || '下校時刻のお知らせ', {
    body: data.body || '',
    tag: data.tag,
    data: { url: data.url || '/' },
    requireInteraction: /当日・翌日/.test(data.body || ''),
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data.url, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url === url && 'focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
