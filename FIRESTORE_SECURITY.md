# Firestore 本番ルール適用メモ

## 追加ファイル
- firestore.rules

## このルールでできること
- ログイン済みユーザーのみ読み取り可能
- 現在の共有ドキュメント構成でも Firebase Authentication を使って運用可能
- `appData` は認証済みユーザーなら誰でも自分の予定などを書き込めるが、`staffAccounts`（利用者一覧）と`settings`（休日設定）フィールドはフィールド単位で管理者のみ変更可能
- `users` は本人または管理者のみ書き込み可能
- 管理者判定は custom claim（`admin=true`）を優先し、未設定でも管理者専用Authメール（`__admin_root_v1@schedule.local`）でフォールバック判定

## 前提
このルールは `request.auth` を使うため、Firebase Authentication が必須です。
現在のアプリは Firebase Authentication ベースに移行し、共有ドキュメント構成を互換運用します。

## 将来の推奨移行
1. Firestore保存先を `appData/weeklySchedule` から以下へ分割
- `users/{uid}`
- `schedules/{uid}/entries/{entryId}`
- `settings/{docId}`
2. 管理者ユーザーへ custom claim `admin=true` を付与
3. `schedules/{uid}` へ移行して本人だけ編集できるルールへ強化

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
