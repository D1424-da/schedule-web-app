const firebaseConfig = {
  apiKey: "AIzaSyD2jqw7F0ayfc2JyUsweWVtYhwNJvuhmR8",
  authDomain: "schedule-web-app-9e829.firebaseapp.com",
  projectId: "schedule-web-app-9e829",
  storageBucket: "schedule-web-app-9e829.firebasestorage.app",
  messagingSenderId: "640202250349",
  appId: "1:640202250349:web:02a9b94bfe09ab8c7e0764",
};

if (typeof window !== "undefined") {
  window.__FIREBASE_CONFIG__ = firebaseConfig;
  // Firebase Cloud Messaging の Web Push 設定
  window.__FIREBASE_VAPID_KEY__ = "";
  // Cloud Functions 等の Push 送信エンドポイント
  window.__PUSH_NOTIFY_ENDPOINT__ = "";
}

if (typeof self !== "undefined") {
  self.__FIREBASE_CONFIG__ = firebaseConfig;
}
