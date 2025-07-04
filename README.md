# Nostr Channel Thread List System

NostrのNIP-28チャンネルスレッドを効率的にキャッシュし、REST APIで提供するシステムです。

## 🚀 **主な機能**

- **高速起動**: 初回同期後は増分同期で瞬時に起動
- **チャンネル管理**: kind 40（作成）、41（メタデータ）、42（メッセージ）の完全対応
- **メタデータ履歴**: チャンネル変更履歴の完全保存
- **REST API**: 柔軟なソート・検索機能付きのWeb API
- **リアルタイム同期**: 新しいイベントの自動同期
- **期間指定リフレッシュ**: システム停止期間のデータ補完
- **NIP-78対応**: アプリケーションデータストレージ

## 🛠 **セットアップ**

### 1. 依存関係のインストール
```bash
npm install
```

### 2. 環境変数の設定
`.env`ファイルを作成し、以下を設定：
```bash
# Nostr秘密鍵（オプション、なしで読み取り専用モード）
HEX=your_private_key_in_hex_format

# APIサーバーのポート番号（オプション、デフォルト: 3000）
API_PORT=3000

# 本番環境設定（オプション、セキュリティ強化のため）
NODE_ENV=production

# CORS許可オリジン（オプション、本番環境では必須）
# カンマ区切りで複数指定可能
ALLOWED_ORIGINS=https://yourdomain.com,https://app.yourdomain.com
```

**セキュリティ設定について:**
- `HEX`を設定しない場合、読み取り専用モードで動作
- `NODE_ENV=production`で本番モードに設定すると、レート制限が厳しくなります
- `ALLOWED_ORIGINS`で許可するオリジンを明示的に指定（本番環境推奨）

### 3. 起動方法

#### 通常のAPIサーバー起動
```bash
# 開発モード
npm run dev

# 本番モード
npm run build
npm start
```

#### データリフレッシュ（期間指定）
```bash
# 全件リフレッシュ
npm run refresh

# 期間指定リフレッシュ
npm run refresh -- since=2025-01-01

# 特定期間のみ
npm run refresh -- since=2025-01-01 until=2025-01-31

# 強制上書きリフレッシュ
npm run refresh:force

# 期間指定 + 強制上書き
npm run refresh -- since=2025-01-01 until=2025-01-31 --force

# ヘルプ表示
npm run help
```

## 📋 **動作モード**

### 🖥️ **サーバーモード**（デフォルト）
- REST APIサーバーとして動作
- リアルタイム同期機能
- cron定期処理
- 通常運用時に使用

### 🔄 **リフレッシュモード**
- 指定期間のデータを一括取得
- データベースに保存後自動終了
- システム停止期間の補完に最適

## 🗓️ **日時指定形式**

リフレッシュコマンドで使用可能な日時形式：

```bash
# YYYY-MM-DD形式
since=2025-01-01

# YYYY-MM-DD HH:mm:ss形式（UTC）
since="2025-01-01 12:30:00"

# Unix タイムスタンプ
since=1735689600

# ISO 8601形式
since=2025-01-01T00:00:00Z
```

## 💡 **使用例**

### 基本的な使用パターン

```bash
# 1. 通常のサーバー起動
npm start

# 2. システム停止期間（1週間）のデータ補完
npm run refresh -- since=2025-01-01 until=2025-01-07

# 3. 特定日以降の全データをリフレッシュ
npm run refresh -- since=2025-01-15 --force

# 4. 開発時のデータリセット
npm run refresh:force
```

### 運用スケジュール例

```bash
# 日次データ補完（前日分）
npm run refresh -- since=$(date -d "yesterday" +%Y-%m-%d)

# 週次データ補完（先週分）  
npm run refresh -- since=$(date -d "1 week ago" +%Y-%m-%d) until=$(date -d "yesterday" +%Y-%m-%d)
```

## 📋 **API エンドポイント**

### チャンネル一覧取得
```
GET /channels?sort=latest&limit=50&with_messages=true
```

**パラメータ:**
- `sort`: `latest` | `oldest` | `created_new` | `created_old` (デフォルト: latest)
- `limit`: 1-200 (デフォルト: 50)
- `with_messages`: true | false (デフォルト: false)

### 特定チャンネル詳細
```
GET /channels/:id
```

### チャンネルメッセージ一覧
```
GET /channels/:id/messages?limit=20
```

### チャンネルメタデータ履歴
```
GET /channels/:id/history?limit=10
```

### 統計情報
```
GET /stats
```

### ヘルスチェック
```
GET /health
```

## 📊 **データベース構造**

### channels テーブル
チャンネルの現在の状態を保持
- `id`: チャンネルID
- `author`: 作成者pubkey
- `name`: チャンネル名
- `content`: 最新のcontent JSON
- `latest_update`: 最終更新時刻
- `created_at`: 作成時刻

### channel_messages テーブル
チャンネルメッセージ（最新3件を保持）
- `id`: メッセージID
- `channel_id`: チャンネルID
- `content`: メッセージ内容
- `pubkey`: 投稿者pubkey
- `created_at`: 投稿時刻

### channel_meta_history テーブル
チャンネルメタデータの変更履歴
- `id`: イベントID
- `channel_id`: チャンネルID
- `kind`: 40（作成）または 41（メタデータ）
- `content`: イベントcontent
- `pubkey`: 投稿者pubkey
- `created_at`: 投稿時刻

## 🔄 **同期戦略**

### 通常起動時の同期
1. **初回起動**: 過去1000件のチャンネル作成イベントを取得し完全同期
2. **2回目以降**: 前回同期時刻以降のイベントのみ取得（増分同期）
3. **リアルタイム**: WebSocket接続で新規イベントを監視

### リフレッシュモード
1. **期間指定**: since/untilパラメータで取得期間を指定
2. **大容量対応**: 最大5000チャンネル、10000メタデータ、20000メッセージ
3. **重複チェック**: 既存データはスキップ（--forceで上書き可能）
4. **統計表示**: 処理結果の詳細レポート

## 🎯 **利用例**

### チャンネル一覧（最新アクティビティ順）
```bash
curl "http://localhost:3000/channels?sort=latest&limit=10&with_messages=true"
```

### 新着チャンネル（作成日順）
```bash
curl "http://localhost:3000/channels?sort=created_new&limit=20"
```

### チャンネル詳細とメッセージ
```bash
curl "http://localhost:3000/channels/CHANNEL_ID"
```

### システム統計
```bash
curl "http://localhost:3000/stats"
```

## ⚡ **パフォーマンス特徴**

- **起動時間**: 初回以降 < 5秒
- **メモリ使用量**: SQLiteで効率的な管理
- **ネットワーク負荷**: 増分同期で80%以上削減
- **レスポンス時間**: インデックス付きで高速クエリ
- **リフレッシュ**: 期間指定で必要なデータのみ取得

## 🚨 **トラブルシューティング**

### システム停止後のデータ補完
```bash
# 停止期間が1週間の場合
npm run refresh -- since=2025-01-01 until=2025-01-07
```

### データが不整合な場合
```bash
# 全データを強制リフレッシュ
npm run refresh:force
```

### エラー時のログ確認
```bash
# 詳細ログ付きで起動
DEBUG=* npm start
```

## 🛡 **セキュリティ**

### セキュリティ機能
- **レート制限**: DDoS攻撃とブルートフォース攻撃の防止
- **CORS制御**: 許可されたオリジンからのアクセスのみ許可
- **セキュリティヘッダー**: Helmet.jsによるXSS、CSRF、クリックジャッキング対策
- **入力バリデーション**: 不正なパラメータの検証とフィルタリング
- **SQLインジェクション対策**: パラメータバインドによる安全なクエリ実行
- **エラーハンドリング**: 本番環境での詳細エラー情報の非表示

### レート制限設定
| 環境 | 通常API | /api プレフィックス | 
|------|---------|-------------------|
| 開発 | 200req/分 | 1000req/15分 |
| 本番 | 200req/分 | 100req/15分 |

### セキュリティログ
- IP アドレス記録
- レート制限違反の監視
- CORS 違反の検出
- 異常なリクエストパターンの警告

### 本番環境推奨設定
```bash
# .env
NODE_ENV=production
ALLOWED_ORIGINS=https://yourdomain.com
HEX=  # 読み取り専用モードで運用
```

## 📝 **ライセンス**

MIT License