# Firestore 本番ルール適用メモ

## 追加ファイル
- firestore.rules

## このルールでできること
- ログイン済みユーザーのみ読み取り可能
- スケジュール更新は本人（または管理者）だけ
- 設定変更は管理者だけ

## 前提
このルールは `request.auth` を使うため、Firebase Authentication が必須です。
現在のアプリは独自ログイン（localStorage）なので、そのままでは本番ルールで書き込みできません。

## 推奨移行
1. Firebase Authentication を導入
2. Firestore保存先を `appData/weeklySchedule` から以下へ分割
- `users/{uid}`
- `schedules/{uid}/entries/{entryId}`
- `settings/{docId}`
3. 管理者ユーザーへ custom claim `admin=true` を付与

## ルール反映コマンド
Firebase CLI を使います。

```bash
firebase login
firebase use <your-project-id>
firebase deploy --only firestore:rules
```

## まずは確認したい項目
- 誰が管理者か
- 全体ページを全員閲覧可にするか（現ルールは閲覧可）
- 退職者データの扱い（削除か無効化か）
