# 受付札

ライブと小さなイベントの取り置き予約を一つのURLに集め、出演者別の集計と当日受付名簿へつなぐWebサービスです。

- 予約者はアカウント不要で、予約名、枚数、受付経路、短いメモだけを送ります。
- 主催者はDM・口頭予約を代理登録し、来場チェック、印刷、CSV出力ができます。
- メール、電話、チャット、画像、事前決済、本人確認は扱いません。
- 主催者と予約者の権限はURLフラグメントに置き、サーバーにはSHA-256ハッシュだけを保存します。
- Cloudflare Workers、Hono JSX、Vite+、D1で動作します。Better Authは不要です。

## 開発

```powershell
npm install
npm run release:check
npm run check
npm test
npm run build
```

データ境界は `PRIVACY.md`、脆弱性の連絡方法は `SECURITY.md` を参照してください。
