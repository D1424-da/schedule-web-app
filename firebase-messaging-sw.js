/* global importScripts, firebase */

importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
importScripts("./firebase-config.js");

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

if (self.__FIREBASE_CONFIG__) {
  firebase.initializeApp(self.__FIREBASE_CONFIG__);
}

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const data = payload?.data || {};
  const title = payload?.notification?.title || data.title || "確認依頼が届きました";
  const body = payload?.notification?.body || data.body || "確認依頼セクションを確認してください。";
  const url = data.url || "/overall.html";

  self.registration.showNotification(title, {
    body,
    data: { url },
    tag: "weekly-confirmation-request",
    renotify: true,
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || "/overall.html";

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of allClients) {
      if ("focus" in client) {
        client.focus();
        client.navigate(url);
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(url);
    }
  })());
});
