# Temp Mail Worker (API only)

Cloudflare Workers + Email Routing で、受信メールを API から取得できる簡易 temp mail を作ります。

## 1) Cloudflare 側の準備

1. Cloudflare にドメインを追加
2. Email Routing を有効化
3. Routing ルールを作成し、対象アドレスをこの Worker にルーティング
4. [wrangler.toml](wrangler.toml) の `DOMAINS` に対象ドメインを設定

## 2) KV を作成

```bash
npm install
npx wrangler kv:namespace create MESSAGES
```

出力された `id` を [wrangler.toml](wrangler.toml) の `CHANGE_ME` に入れてください。

## 3) デプロイ

```bash
npx wrangler deploy
```

## API

- `POST /create` → 新しい temp address を作成
- `GET /messages?address=<address>` → そのアドレスの受信一覧
- `GET /messages/<id>` → 受信詳細

レスポンスには `text` が含まれ、`text/plain` を可能な範囲でデコードします。

### 認証 (任意)

[wrangler.toml](wrangler.toml) の `API_KEY` を設定すると、
`Authorization: Bearer <API_KEY>` が必要になります。

### 例

```bash
curl -X POST https://<your-worker>.workers.dev/create
curl "https://<your-worker>.workers.dev/messages?address=abc@ryoh.dev"
```

## メモ

- Email Routing の受信対象はワイルドカードでも OK です。
- `DOMAINS` はカンマ区切りまたはスペース区切りで複数指定できます。
- `FORWARD_TO` を設定すると、受信メールを別アドレスへ転送します。
