// クラウド同期(WebDAV / Nextcloud)。
//
// サーバーには「ただのファイル置き場」として使う。自前のサーバープログラムは要らない。
//   <フォルダ>/daigaku-note/ops/<端末ID>/<開始番号>-<終了番号>.json  … その端末が書いた変更(追記のみ)
//   <フォルダ>/daigaku-note/files/<sha256>.pdf(.png .jpg など)          … 読み込んだ PDF・画像
// 各端末は自分の変更だけを書き込み、ほかの端末のファイルを読み込む。
// 変更は順番に関係なく合わさるので、同時に書いても衝突しない。

import * as db from './db.js';
import { fileRefs, fileExt } from './model.js';

const FORMAT = 'daigaku-note-ops';
let cfg = {};
let st = { key: '', sentC: 0, seen: [], sentFiles: [] };
let recorder = null, onRemoteChange = () => {}, onStatus = () => {};
let timer = 0, running = false, again = false, dirsReady = '';

export const config = () => ({ ...cfg });
const enabled = () => !!(cfg.url && cfg.user);

export async function init(opts) {
  recorder = opts.recorder;
  onRemoteChange = opts.onRemoteChange;
  onStatus = opts.onStatus;
  cfg = (await db.getMeta('dav')) || {};
  const saved = await db.getMeta('davState');
  if (saved && saved.key === stateKey()) st = saved;
  onStatus(enabled() ? 'クラウド同期: 準備中' : '');
  setInterval(() => { if (enabled() && cfg.auto !== false && document.visibilityState === 'visible') syncNow(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(500); });
  window.addEventListener('online', () => schedule(500));
  if (enabled() && cfg.auto !== false) schedule(1000);
}

const stateKey = () => `${cfg.url}|${cfg.user}`;

export async function configure(next) {
  cfg = next;
  if (cfg.url && !cfg.url.endsWith('/')) cfg.url += '/';
  await db.setMeta('dav', cfg);
  if (st.key !== stateKey()) {
    st = { key: stateKey(), sentC: 0, seen: [], sentFiles: [] };
    await db.setMeta('davState', st);
  }
}

// 変更のあと少し待ってから同期する
export function schedule(ms = 4000) {
  if (!enabled() || cfg.auto === false) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), ms);
}

function base() {
  return cfg.url + 'daigaku-note/';
}

async function dav(method, path, { body, headers = {}, ok = [200, 201, 204, 207] } = {}) {
  const auth = 'Basic ' + btoa(unescape(encodeURIComponent(`${cfg.user}:${cfg.pass || ''}`)));
  const res = await fetch(base() + path, { method, body, headers: { Authorization: auth, ...headers }, cache: 'no-store' });
  if (!ok.includes(res.status)) {
    const err = new Error(`${method} ${path || '/'}: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function mkcol(path) {
  await dav('MKCOL', path, { ok: [201, 405, 301] }); // 405 = すでにある
}

// フォルダの中身(名前の一覧。フォルダは末尾に / )
async function list(path) {
  const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
  const res = await dav('PROPFIND', path, { body, headers: { Depth: '1', 'Content-Type': 'application/xml' }, ok: [207, 404] });
  if (res.status === 404) return [];
  const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
  const self = new URL(base() + path).pathname.replace(/\/+$/, '');
  const names = [];
  for (const r of xml.getElementsByTagNameNS('DAV:', 'response')) {
    const href = r.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent || '';
    const p = decodeURIComponent(new URL(href, base()).pathname);
    const isDir = r.getElementsByTagNameNS('DAV:', 'collection').length > 0 || p.endsWith('/');
    const clean = p.replace(/\/+$/, '');
    if (clean === decodeURIComponent(self)) continue;
    const name = clean.split('/').pop();
    names.push(isDir ? name + '/' : name);
  }
  return names;
}

// ファイルを手元に持っているか、サーバーから取ってこられたら true
async function fetchFile(ref) {
  if (await db.hasFile(ref.hash)) return true;
  const name = `${ref.hash}.${fileExt(ref.type)}`;
  const res = await dav('GET', 'files/' + name, { ok: [200, 404] });
  if (res.status !== 200) return false;
  await db.putFile({ hash: ref.hash, name, type: ref.type, data: new Blob([await res.blob()], { type: ref.type }) });
  return true;
}
function addMissing(ref, n) {
  st.missing = st.missing || [];
  if (!st.missing.some((m) => m.hash === ref.hash)) st.missing.push({ hash: ref.hash, type: ref.type, n });
}

export async function syncNow(manual = false) {
  if (!enabled()) return;
  if (running) { again = true; return; }
  running = true;
  onStatus('クラウド同期: 同期しています…');
  try {
    const me = recorder.device;
    if (dirsReady !== stateKey()) {
      await mkcol('');
      await mkcol('ops/');
      await mkcol(`ops/${me}/`);
      await mkcol('files/');
      dirsReady = stateKey();
    }

    // 1) 自分の新しい変更を書き込む
    const mine = (await db.opsByDevice(me)).filter((o) => o.c > st.sentC).sort((a, b) => a.c - b.c);
    let sent = 0;
    if (mine.length) {
      for (const op of mine) {
        for (const ref of fileRefs(op)) {
          if (st.sentFiles.includes(ref.hash)) continue;
          const name = `files/${ref.hash}.${fileExt(ref.type)}`;
          const head = await dav('HEAD', name, { ok: [200, 404] });
          if (head.status === 404) {
            const f = await db.getFile(ref.hash);
            if (f) await dav('PUT', name, { body: f.data, headers: { 'Content-Type': ref.type } });
          }
          st.sentFiles.push(ref.hash);
        }
      }
      const from = mine[0].c, to = mine[mine.length - 1].c;
      const body = JSON.stringify({ format: FORMAT, version: 1, device: me, ops: mine });
      await dav('PUT', `ops/${me}/${String(from).padStart(9, '0')}-${String(to).padStart(9, '0')}.json`, { body, headers: { 'Content-Type': 'application/json' } });
      st.sentC = to;
      sent = mine.length;
      await db.setMeta('davState', st);
    }

    // 2) ほかの端末の変更を読み込む
    const seen = new Set(st.seen);
    const changed = new Set();
    let got = 0;
    for (const dir of await list('ops/')) {
      if (!dir.endsWith('/') || dir === me + '/') continue;
      const files = (await list(`ops/${dir}`)).filter((f) => f.endsWith('.json')).sort();
      for (const f of files) {
        const path = `ops/${dir}${f}`;
        if (seen.has(path)) continue;
        const json = await (await dav('GET', path)).json();
        const ops = (json.ops || []).filter((o) => o && typeof o.id === 'string' && typeof o.l === 'number' && o.n && o.t);
        for (const op of ops) {
          for (const ref of fileRefs(op)) {
            if (!(await fetchFile(ref))) addMissing(ref, op.n);
          }
          recorder.observe(op);
        }
        got += await db.putOps(ops, recorder.clock);
        for (const op of ops) changed.add(op.n);
        seen.add(path);
        st.seen = [...seen];
        await db.setMeta('davState', st);
      }
    }
    // 3) まだ手元にないファイル(送った端末がまだ上げていなかったもの、古い版のアプリでは受け取らなかった画像)を取りに行く
    if (!st.filesScanned) {
      // 一度だけ、全部の op を見て足りないファイルを探す(画像に対応していない版から更新したとき用)
      for (const op of await db.allOps()) for (const ref of fileRefs(op)) if (!(await db.hasFile(ref.hash))) addMissing(ref, op.n);
      st.filesScanned = true;
      await db.setMeta('davState', st);
    }
    if (st.missing && st.missing.length) {
      const still = [];
      for (const m of st.missing) {
        if (await fetchFile(m)) { changed.add(m.n); got++; continue; }
        // サーバーにずっと無いファイルは、50回試したらあきらめる(毎回取りに行き続けないように)
        m.tries = (m.tries || 0) + 1;
        if (m.tries < 50) still.push(m);
      }
      st.missing = still;
      await db.setMeta('davState', st);
    }
    const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    onStatus(`クラウド同期: ${time} に同期しました` + (manual ? `(送信 ${sent}件・受信 ${got}件)` : ''));
    if (got) onRemoteChange(changed);
  } catch (e) {
    console.error(e);
    let msg = e.message;
    if (e instanceof TypeError) msg = 'サーバーに接続できません。URL・ネット接続・CORS の設定を確認してください';
    else if (e.status === 401) msg = 'ユーザー名またはパスワードが違います';
    else if (e.status === 404 || e.status === 409) msg = 'フォルダのURLが見つかりません';
    onStatus('クラウド同期に失敗しました: ' + msg);
  } finally {
    running = false;
    if (again) { again = false; schedule(1000); }
  }
}
