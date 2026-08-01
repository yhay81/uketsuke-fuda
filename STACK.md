# 技術構成

- Cloudflare Workers: 配信、API、日次削除
- Hono / Hono JSX: ルーティングとサーバー描画
- Vite+: 開発、型検査、テスト、ビルド
- Cloudflare D1: 期限付きイベント、予約、匿名集計
- TypeScript 7 / Node.js 24 LTS / npm

Better Authは使わない。予約者アカウントを作る必要がなく、イベント単位の能力URLの方が保存データと操作負担を小さくできるため。

CSSとSVGはリポジトリ内で管理し、外部フォント、外部JavaScript、外部画像を読み込まない。
