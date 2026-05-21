# 確認依頼のバックグラウンドPush通知セットアップ

このアプリは以下を実装済みです。

- Service WorkerでのPush受信
- FCMトークンのFirestore登録（`pushTokens/{token}`）
- 確認依頼作成時にPush送信API（`__PUSH_NOTIFY_ENDPOINT__`）へPOST

閉じたブラウザにも通知するには、Firebase Cloud Messaging へ送信するサーバー処理が必要です。

## 1. firebase-config.js の設定

`firebase-config.js` を編集して設定します。

- `window.__FIREBASE_VAPID_KEY__`: Firebase Console の Web Push 証明書キー
- `window.__PUSH_NOTIFY_ENDPOINT__`: Cloud Functions HTTPSエンドポイント

## 2. Cloud Functions の実装例

以下は Node.js（firebase-admin）での最小例です。

```js
// index.js (Cloud Functions)
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();

exports.pushNotify = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const {
      targetId,
      requesterName,
      ownerName,
      startDate,
      repeatDays,
      requestId,
    } = req.body || {};

    if (!targetId) {
      res.status(400).json({ error: "targetId is required" });
      return;
    }

    const snapshot = await admin.firestore()
      .collection("pushTokens")
      .where("loginId", "==", String(targetId))
      .where("enabled", "==", true)
      .get();

    const tokens = snapshot.docs.map((doc) => doc.id).filter(Boolean);
    if (tokens.length === 0) {
      res.status(200).json({ ok: true, sent: 0 });
      return;
    }

    const multicast = {
      tokens,
      notification: {
        title: "確認依頼が届きました",
        body: `${requesterName || "利用者"} から ${ownerName || "予定"} の確認依頼があります`,
      },
      data: {
        url: `/overall.html?requestId=${encodeURIComponent(String(requestId || ""))}`,
        type: "confirmation-request",
        startDate: String(startDate || ""),
        repeatDays: String(repeatDays || "1"),
      },
      webpush: {
        fcmOptions: {
          link: "https://d1424-da.github.io/schedule-web-app/overall.html",
        },
      },
    };

    const result = await admin.messaging().sendEachForMulticast(multicast);
    res.status(200).json({ ok: true, sent: result.successCount, failed: result.failureCount });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});
```

## 3. デプロイ後にエンドポイントを反映

Cloud FunctionsのURLを `window.__PUSH_NOTIFY_ENDPOINT__` に設定します。

## 4. Firestoreルールの反映

このリポジトリには `pushTokens` 用ルールを追加済みです。反映してください。

```bash
firebase deploy --only firestore:rules
```

## 5. 動作確認

1. 全端末でログイン
2. 各端末で「通知を有効にする」を実行
3. 確認依頼を送信
4. 受信側でブラウザを閉じた状態でもPushが届くことを確認
