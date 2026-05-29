#!/usr/bin/env node
'use strict';

/*
 * Ghost Liner ローカル同期サーバー
 * 依存ゼロ（Node 標準ライブラリのみ）。Firebase Realtime Database の使用サブセットを再現する。
 *
 *  - 単一のグローバル dataTree を保持し db.json に永続化（200ms デバウンス）。
 *  - GET  /sub?path=<p>   SSE。接続時に node@p を送信し、p に影響する書き込みごとに再送。
 *  - POST /op  {op:'set'|'update', path, value}  ツリーへ適用 → 保存 → 購読者へ再送。
 *  - その他は public/ 配下を静的配信（/ は index.html）。
 *
 *  0.0.0.0:PORT で待受（既定 8080）。同一LANのスマホから http://<MacのIP>:PORT で接続。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8765', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(__dirname, 'db.json');

// ---- データツリー（= Firebase の DB ルート相当） ---------------------------

let dataTree = {};
try {
  if (fs.existsSync(DB_FILE)) {
    dataTree = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) || {};
    console.log(`[db] loaded ${DB_FILE}`);
  }
} catch (e) {
  console.error(`[db] 読み込み失敗（空で開始）: ${e.message}`);
  dataTree = {};
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DB_FILE, JSON.stringify(dataTree), (err) => {
      if (err) console.error(`[db] 保存失敗: ${err.message}`);
    });
  }, 200);
}

// プロセス終了時（Ctrl+C など）は保留中の変更を確実に同期保存する
function flushNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { fs.writeFileSync(DB_FILE, JSON.stringify(dataTree)); }
  catch (e) { console.error(`[db] 終了時保存失敗: ${e.message}`); }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { flushNow(); process.exit(0); });
}

// パス文字列 'rooms/123/game' → ['rooms','123','game']（空要素は除去）
function splitPath(p) {
  return String(p || '').split('/').filter((s) => s.length > 0);
}

// プロトタイプ汚染を防ぐ危険キー（DBキーとして使わせない）
function unsafeSeg(k) {
  return k === '__proto__' || k === 'constructor' || k === 'prototype';
}

// node@segs を取得（存在しなければ undefined）
function getPath(segs) {
  let node = dataTree;
  for (const key of segs) {
    if (node === null || typeof node !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

// node@segs を value で置換（value===null は削除＋空親の剪定）。Firebase set 相当。
function setPath(segs, value) {
  if (segs.some(unsafeSeg)) { console.warn(`[security] 危険キーを拒否: ${segs.join('/')}`); return; }
  if (segs.length === 0) {
    // ルート全体の置換
    dataTree = value === null ? {} : value;
    return;
  }
  if (value === null) {
    deletePath(segs);
    return;
  }
  let node = dataTree;
  for (let i = 0; i < segs.length - 1; i++) {
    const key = segs[i];
    if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[segs[segs.length - 1]] = value;
}

// node@segs を削除し、空になった親オブジェクトを上方向に剪定（Firebase: 空ノードは消える）
function deletePath(segs) {
  const chain = [dataTree];
  let node = dataTree;
  for (let i = 0; i < segs.length - 1; i++) {
    const key = segs[i];
    if (node === null || typeof node !== 'object' || !(key in node)) return; // 既に無い
    node = node[key];
    chain.push(node);
  }
  const leaf = segs[segs.length - 1];
  if (node && typeof node === 'object') delete node[leaf];
  // 空親の剪定
  for (let i = chain.length - 1; i >= 1; i--) {
    const obj = chain[i];
    if (obj && typeof obj === 'object' && Object.keys(obj).length === 0) {
      delete chain[i - 1][segs[i - 1]];
    } else {
      break;
    }
  }
}

// Firebase update 相当: 各 key（スラッシュ深いパス可、値 null は削除）を base 基準で適用。マージ。
function applyUpdate(baseSegs, updates) {
  for (const key of Object.keys(updates)) {
    const segs = baseSegs.concat(splitPath(key));
    setPath(segs, updates[key]);
  }
}

// ---- ロングポーリング購読管理 ----------------------------------------------
// SSE はプロキシ/CDN（Cloudflare 等）にバッファされ届かないため、変化があるまで
// 応答を保留して 1 回の通常レスポンスで返すロングポーリングを採用。どんな経路でも通る。

let rev = 0;                 // 書き込みのたびに増えるグローバル版数
const waiters = new Set();   // 保留中の { pathStr, segs, res, timer }

function pathsAffected(a, b) {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function respondPoll(res, segs) {
  const node = getPath(segs);
  const body = JSON.stringify({ rev, value: node === undefined ? null : node });
  try {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (_) { /* 既に切断 */ }
}

// 書き込みパス opPath に影響する保留中ポーラーへ即応答
function notify(opPathStr) {
  rev++;
  for (const w of Array.from(waiters)) {
    if (pathsAffected(w.pathStr, opPathStr)) {
      clearTimeout(w.timer);
      waiters.delete(w);
      respondPoll(w.res, w.segs);
    }
  }
}

// ---- HTTP ハンドラ ---------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // パストラバーサル防止: public 配下に正規化（区切り文字境界で判定し public2 等の兄弟ディレクトリを排除）
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const POLL_TIMEOUT = 20000; // 変化が無ければ 20 秒で現在値を返し、クライアントが再ポーリング

function handlePoll(req, res, query) {
  const segs = splitPath(query.path);
  const pathStr = segs.join('/');
  const clientRev = parseInt(query.rev, 10);
  // 初回(rev未指定/NaN)や版数が違えば現在値を即返す
  if (isNaN(clientRev) || clientRev !== rev) {
    return respondPoll(res, segs);
  }
  // 最新まで追いついている → 変化があるまで保留
  const w = { pathStr, segs, res, timer: null };
  w.timer = setTimeout(() => { waiters.delete(w); respondPoll(res, segs); }, POLL_TIMEOUT);
  waiters.add(w);
  const cleanup = () => { clearTimeout(w.timer); waiters.delete(w); };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

const MAX_BODY = 5 * 1024 * 1024; // 5MB

function handleOp(req, res) {
  // Content-Length 申告が上限超なら受信前に拒否
  const cl = parseInt(req.headers['content-length'] || '0', 10);
  if (cl > MAX_BODY) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end('{"error":"payload too large"}'); return;
  }
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > MAX_BODY) { req.destroy(); } // チャンク送りの暴走も遮断
  });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad json"}'); return;
    }
    const { op, path: p, value } = msg || {};
    const baseSegs = splitPath(p);
    const pathStr = baseSegs.join('/');
    try {
      if (op === 'set') {
        setPath(baseSegs, value === undefined ? null : value);
      } else if (op === 'update') {
        if (value && typeof value === 'object') applyUpdate(baseSegs, value);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"unknown op"}'); return;
      }
    } catch (e) {
      console.error(`[op] 適用失敗: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"apply failed"}'); return;
    }
    scheduleSave();
    notify(pathStr);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;

  if (req.method === 'GET' && pathname === '/poll') {
    return handlePoll(req, res, { path: parsed.searchParams.get('path'), rev: parsed.searchParams.get('rev') });
  }
  if (req.method === 'POST' && pathname === '/op') return handleOp(req, res);
  if (req.method === 'GET' && pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET') return serveStatic(req, res, pathname);

  res.writeHead(405); res.end('method not allowed');
});

// ロングポーリングは応答を最大 POLL_TIMEOUT 保留する（リクエスト受信は即時）。
// ヘッダ受信タイムアウト（slowloris 対策）は有効、リクエスト全体のタイムアウトは無効にしておく。
server.headersTimeout = 60000;   // ヘッダ受信に60秒以上かかる接続は遮断
server.requestTimeout = 0;       // 保留中の応答が打ち切られないようリクエスト全体のタイムアウトは無効
server.keepAliveTimeout = 30000; // 連続ポーリングで接続を再利用

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ポート ${PORT} は既に使用中です。別のポートで起動してください:`);
    console.error(`    PORT=8770 node server.js\n`);
  } else {
    console.error(`  サーバーエラー: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Ghost Liner local server`);
  console.log(`  ------------------------`);
  console.log(`  このMac:   http://localhost:${PORT}`);
  // LAN IP を表示
  try {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const ni of nets[name]) {
        if (ni.family === 'IPv4' && !ni.internal) {
          console.log(`  スマホから: http://${ni.address}:${PORT}   (同じWi-Fi内)`);
        }
      }
    }
  } catch (_) { /* noop */ }
  console.log(`  停止: Ctrl+C\n`);
});
