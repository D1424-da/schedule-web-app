# 確認依頼のバックグラウンドPush通知セットアップ

このアプリは以下を実装済みです。

- Service WorkerでのPush受信
- FCMトークンのFirestore登録（`pushTokens/{token}`）
- 確認依頼作成時にPush送信API（`__PUSH_NOTIFY_ENDPOINT__`）へPOST

閉じたブラウザにも通知するには、Firebase Cloud Messaging へ送信するサーバー処理が必要です。

`functions/` ディレクトリに Cloud Functions の実装（`pushNotify`）を同梱済みです。未認証の第三者が任意の利用者へ通知を送りつけられないよう、呼び出し元のFirebase IDトークン（`Authorization: Bearer <idToken>`）を検証してから送信します（`app.js` の `triggerServerPushForConfirmationRequest` が自動的に付与します）。

## 1. firebase-config.js の設定

`firebase-config.js` を編集して設定します。

- `window.__FIREBASE_VAPID_KEY__`: Firebase Console の Web Push 証明書キー
- `window.__PUSH_NOTIFY_ENDPOINT__`: Cloud Functions HTTPSエンドポイント（デプロイ後にURLが決まります）

## 2. Cloud Functions のデプロイ

同梱の `functions/` をそのままデプロイできます。

```bash
firebase login
firebase use <your-project-id>
cd functions && npm install && cd ..
firebase deploy --only functions
```

デプロイ完了時に表示されるHTTPS関数のURLを、手順1の `window.__PUSH_NOTIFY_ENDPOINT__` に設定してください。

## 3. Firestoreルールの反映

このリポジトリには `pushTokens` 用ルールを追加済みです。反映してください。

```bash
firebase deploy --only firestore:rules
```

## 4. 動作確認

1. 全端末でログイン
2. 各端末で「通知を有効にする」を実行
3. 確認依頼を送信
4. 受信側でブラウザを閉じた状態でもPushが届くことを確認
