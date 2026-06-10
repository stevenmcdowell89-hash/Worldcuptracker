// Service worker for the WC26 PWA (brief §14). Minimal by design: it exists for
// install-to-home-screen and to receive web push. No asset caching — the Worker
// serves the app with no-cache so deploys always reach the browser; an offline
// cache here would just risk serving stale code.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  const title = data.title || "WC26";
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    tag: data.tag,                 // same tag collapses a re-sent update
    renotify: !!data.tag,
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { url: data.url || "/#/matches" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/#/matches";
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) {
      if ("focus" in c) { try { await c.navigate(url); } catch {} return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
