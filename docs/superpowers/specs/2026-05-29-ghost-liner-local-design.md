# Ghost Liner ローカル版 — 設計書

- 日付: 2026-05-29
- 目的: Netlify 上の Ghost Liner (`https://helpful-treacle-6d1065.netlify.app`) を、
  作者の Firebase に依存せず **このMac上で完全ローカルに稼働**させ、同一LAN内のスマホから複数端末同期で遊べるようにする。公開しない／外部サーバーにただ乗りしない。

## 元アプリの構造（調査結果）

- 実体は **単一の `index.html`**（約85KB、HTML/CSS/JS インライン）。Netlify は静的配信のみ。
- 複数端末同期は **Firebase Realtime Database**。全状態を `rooms/{roomId}` の1ツリーに格納。
- 認証は **匿名認証のみ**。
- 使用している Firebase API は最小集合のみ:
  - `firebase.initializeApp(config)` / `firebase.auth().signInAnonymously()` / `firebase.database()`
  - `db.ref('rooms/'+id)` → `.on('value', cb)` / `.off()` / `.set(v)` / `.update(obj)` / `.child(path).set(v)`
  - snapshot は `.val()` のみ使用（`.exists()`・`.key`・`push()`・`ServerValue` 等は不使用）
  - `update(obj)` の key は `'game/day'` のようなスラッシュ深いパス、値 `null` は削除。
  - タイマーは各端末の `Date.now()`（epoch ms）を DB に保存し、各端末で経過を計算（クロック同期前提＝元仕様のまま）。

## 方針

元アプリのロジックは **1行も変更しない**。違いは、Firebase SDK を読み込む 3 本の `<script>` を
自作 `firebase-shim.js` に差し替えるだけ。shim が `window.firebase` を生やし、同じ API 表面を
ローカルサーバーへの通信（SSE 購読 + HTTP POST 書き込み）に翻訳する。

## アーキテクチャ（依存ゼロ＝Node 標準ライブラリのみ）

```
[スマホ/PC ブラウザ]
  │  EventSource  GET /sub?path=rooms/{id}   ← 変更時に該当ノードのスナップショットを push
  │  fetch POST   /op  {op:set|update, path, value}  → サーバーがツリーへ適用
  ▼
[Mac: server.js (Node http)]  グローバル dataTree を保持 → db.json に永続化
```

- realtime は **WebSocket ではなく SSE + HTTP POST**。理由: Node 標準 `http` のみで実装でき
  `npm install` 不要。LAN 内なら遅延は体感ゼロ、再接続は EventSource 標準機能で自動。
- サーバーは Firebase の単一DBツリーを一般化して再現する（パス指定の set/update、null 削除、
  空ノードの剪定、サブツリー購読）。元の `rooms/{id}` モデルがそのまま乗る。

## コンポーネント

1. **`server.js`**（1ファイル, 標準ライブラリのみ）
   - 静的配信: `/` → `public/index.html`、その他 `public/` 配下。
   - `GET /sub?path=<p>`: SSE。接続時に node@p を即送信し、以後 p に影響する書き込みごとに再送。
     25秒ごとにコメント ping でキープアライブ。
   - `POST /op` body `{op:'set'|'update', path, value}`:
     - `set`: path のノードを value で置換（value=null は削除＋空親の剪定）。
     - `update`: value の各 `key`(スラッシュ可)/`val` を path 基準で deep-set（null 削除、マージ）。
     - 適用後 `db.json` に保存（200ms デバウンス）、影響を受ける購読者へ node を再送。
   - `0.0.0.0:8080` で待受（LAN 公開）。ポートは環境変数 `PORT` で変更可。
2. **`public/firebase-shim.js`**
   - `window.firebase = { initializeApp, auth, database }` を提供。
   - `auth().signInAnonymously()` → 解決済み Promise。
   - `database().ref(path)` → ref。`.on('value',cb)` で `/sub` に EventSource 接続し、受信スナップショットを
     `{ val:()=>data, exists:()=>data!==null }` として cb に渡す。`.off()` で切断。
   - `.set/.update/.child(p).set` → `/op` への POST に変換。`child` はパス合成した ref を返す。
3. **`public/index.html`**: 元アプリのコピー。**変更は冒頭 gstatic firebase 3行 →
   `<script src="/firebase-shim.js"></script>` の置換と、未使用の firebaseConfig 削除のみ。**
4. **`README.md`** + **`start.command`**（ダブルクリック起動）。Mac の LAN IP の確認
   (`ipconfig getifaddr en0`) とスマホ接続手順を記載。

## データフロー（同期の肝）

全状態は元と同じ `rooms/{roomId}` の1ツリー。どの端末が書いても →
サーバーが適用・保存 → 同パス購読者全員へ該当ノードを再配信 → 各端末の `on('value')` が発火し再描画。
「1ルーム = 1状態を全員で共有」を完全再現。

## 永続化・回復性

- 全DBツリーを `db.json` に保存（Mac 再起動でも保持）。元の「24時間で消える」は不採用。
- スマホのスリープ→復帰: EventSource が自動再接続し、復帰時に最新スナップショットを再送。
- 元アプリの全リセットボタン（`update({inputs:null,...})`）はそのまま動作。

## 非目標 (YAGNI)

- 認証・アクセス制御（LAN 内・身内利用前提）。
- 24時間自動失効。
- Google Fonts のセルフホスト（CDN 取得、無ければ素直にフォールバック。README に補足）。

## 検証

- Node 製テストクライアントで購読・`/op`（set/update/child-set/null削除/マージ）を確認。
- ブラウザ2タブを同一 room で開き、一方の操作が他方へ反映されること（同期）を Playwright で確認。
- アプリ初期化（room=null → set 初期化）→ 設定変更 → ロール配布 → 入力 → 集計までの一連が動くこと。

## 更新履歴

### 2026-05-29 リアルタイム方式を SSE → ロングポーリングに変更
- 当初 SSE（`/sub`）で実装したが、**Cloudflare 等のプロキシ/CDN が `text/event-stream` を
  バッファするため、トンネル越しでは同期プッシュが届かない**ことを実測で確認（ローカル3件/トンネル0件）。
- 対策として、変化があるまでサーバーが応答を保留し1回の通常レスポンスで返す**ロングポーリング（`/poll`）**へ変更。
  通常のHTTP応答なのでどんな経路でも通り、ローカルでも体感は即時。`server.js` と `firebase-shim.js` の購読部のみ差し替え。

### 2026-05-29 共有Wi-Fi（端末分離）対策として Cloudflare トンネルを追加
- マンション共用ネット（`10.x` /22 の管理網）は**クライアントアイソレーション**で端末間通信が不可。
  ARPで他端末が `(incomplete)` ＝AP がstation間通信を遮断、と特定（ファイアウォール・VPNはシロ）。
- LAN を使わずネット経由で繋ぐため、`cloudflared` クイックトンネル（無料・アカウント不要）で
  ローカルサーバーを一時公開する `share.command` を追加。データは Mac の `db.json` に留まる。
```
