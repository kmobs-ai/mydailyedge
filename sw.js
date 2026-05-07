// My DailyEdge service worker — handles push events even when the tab is closed.
// Versioned cache name lets us evict on bumps.
const SW_VERSION = "v1";

self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

// Incoming push from the server (cron worker).
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: "My DailyEdge", body: event.data ? event.data.text() : "Alert triggered" }; }

  const title = data.title || "My DailyEdge alert";
  const opts = {
    body: data.body || "An alert was triggered.",
    icon: "/icon-512.png",
    badge: "/favicon.png",
    tag: data.tag || "mde-alert",
    renotify: !!data.tag,
    data: { url: data.url || "/?tab=alerts" },
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

// Click handler — open or focus the app, deep-link to the right tab.
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clientList) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        client.postMessage({ type: "navigate", url: targetUrl });
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});
