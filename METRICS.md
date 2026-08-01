# 指標

実利用は `product_events.is_qa = 0` だけを集計する。

## 流れ

- `visited`: サービスを開いた匿名利用者
- `event_created`: 受付を作った主催者と対象イベント
- `reservation_created`: 予約または代理予約を作った利用者と対象イベント
- `event_managed`: 受付の開閉を行った主催者
- `reservation_managed`: 取消、復帰、来場チェックを行った利用者
- `roster_exported`: CSVを出力した主催者
- `returned`: 同じブラウザーから別日に再訪した匿名利用者の概数

イベントは名称、匿名セッション、対象イベント、JSTの日付の組み合わせで1日1件に制限する。`npm run metrics` で本番、`npm run metrics -- -Local` でローカルD1を集計する。
