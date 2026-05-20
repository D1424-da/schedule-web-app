# Firebase Authentication 設定メモ

このアプリは Firebase Authentication のメール/パスワード認証を使います。
画面上は「名前(ID)」と「任意の8桁数字パスワード」で扱い、内部では Firebase 用の疑似メールアドレスへ変換して認証します。

## Firebase Console で必要な設定

1. Authentication を有効化
2. Sign-in method で「メール / パスワード」を有効化
3. Firestore を有効化
4. [firebase-config.js](firebase-config.js) にプロジェクト情報を設定

## 補足

- 画面のログインID: 名前(ID)
- パスワード: 任意の8桁数字
- Firebase 側では `xxx@schedule.local` 形式の内部メールへ変換して管理します
- 既存の GitHub Pages でも動作しますが、Firebase 設定が未完了だと認証画面から先へ進めません

## Firestore ルール

互換運用のため、現在の共有ドキュメント構成では認証済みユーザーに読み書きを許可する前提です。
本格的に本人だけ編集可へ強化する場合は、将来的に `/users` と `/schedules/{uid}` 構成へ移行してください。
