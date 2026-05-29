/*
 * firebase-shim.js — local_gl ローカル版
 *
 * 元アプリが使う Firebase Realtime Database のサブセットだけを、
 * ローカルサーバー（server.js）への SSE 購読 + HTTP POST に翻訳して再現する。
 * これにより index.html 側のロジックは一切変更せずに動く。
 *
 * 再現する API:
 *   firebase.initializeApp(config)
 *   firebase.auth().signInAnonymously() -> Promise
 *   firebase.database().ref(path)
 *     ref.on('value', cb)   ... cb(snapshot), snapshot.val()/.exists()
 *     ref.off()
 *     ref.set(value)
 *     ref.update(updatesObj)   // key はスラッシュ深いパス可、値 null は削除
 *     ref.child(path)          // -> 子 ref
 */
(function () {
  'use strict';

  // 同一オリジン（このページを配信したサーバー）に対して通信する
  const ORIGIN = '';

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function postOp(body) {
    try {
      const res = await fetch(ORIGIN + '/op', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      });
      if (!res.ok) console.warn('[shim] /op 失敗:', res.status);
    } catch (e) {
      console.warn('[shim] /op 通信エラー:', e && e.message);
    }
  }

  function makeSnapshot(data) {
    return {
      val: function () { return data === undefined ? null : data; },
      exists: function () { return data !== undefined && data !== null; },
    };
  }

  function Ref(pathStr) {
    this._path = pathStr.split('/').filter(function (s) { return s.length > 0; }).join('/');
    this._poll = 0;      // 購読世代（off/張り替えで無効化）
    this._cb = null;     // value コールバック
  }

  Ref.prototype.child = function (childPath) {
    return new Ref(this._path + '/' + childPath);
  };

  // ロングポーリングで購読する（SSE はプロキシにバッファされ届かないため）。
  // 変化があるまでサーバーが応答を保留 → 受信したら cb を発火し、ただちに次のポーリングへ。
  Ref.prototype.on = function (eventType, callback) {
    if (eventType !== 'value') {
      console.warn('[shim] 未対応イベント:', eventType);
      return callback;
    }
    this._cb = callback;
    const self = this;
    const gen = ++this._poll; // この購読の世代
    let rev = -1;             // 初回は必ず現在値を受け取る
    async function loop() {
      while (self._poll === gen) {
        try {
          const res = await fetch(
            ORIGIN + '/poll?path=' + encodeURIComponent(self._path) + '&rev=' + rev,
            { cache: 'no-store' }
          );
          if (self._poll !== gen) return;        // off() 済み
          if (!res.ok) { await sleep(1500); continue; }
          const data = await res.json();         // { rev, value }
          if (self._poll !== gen) return;
          rev = data.rev;
          if (self._cb) self._cb(makeSnapshot(data.value));
        } catch (e) {
          if (self._poll !== gen) return;
          await sleep(1500);                     // 一時的な通信エラーは待って再試行
        }
      }
    }
    loop();
    return callback;
  };

  Ref.prototype.off = function () {
    this._poll++;  // 進行中のループを無効化
    this._cb = null;
  };

  Ref.prototype.set = function (value) {
    return postOp({ op: 'set', path: this._path, value: value === undefined ? null : value });
  };

  Ref.prototype.update = function (updates) {
    return postOp({ op: 'update', path: this._path, value: updates || {} });
  };

  // ---- firebase グローバル ----
  const database = {
    ref: function (p) { return new Ref(p || ''); },
  };

  const auth = {
    currentUser: { uid: 'local-anon', isAnonymous: true },
    signInAnonymously: function () {
      return Promise.resolve({ user: { uid: 'local-anon', isAnonymous: true } });
    },
    onAuthStateChanged: function (cb) {
      try { cb(this.currentUser); } catch (_) { /* noop */ }
      return function () {};
    },
  };

  window.firebase = {
    initializeApp: function () { return { name: '[DEFAULT]' }; },
    auth: function () { return auth; },
    database: function () { return database; },
  };
})();
