// クラウド同期(WebDAV / Nextcloud)。
//
// サーバーには「ただのファイル置き場」として使う。自前のサーバープログラムは要らない。
//   <フォルダ>/daigaku-note/ops/<端末ID>/<開始番号>-<終了番号>.json  … その端末が書いた変更(追記のみ)
//   <フォルダ>/daigaku-note/files/<sha256>.pdf(.png .jpg など)          … 読み込んだ PDF・画像
// 各端末は自分の変更だけを書き込み、ほかの端末のファイルを読み込む。
// 変更は順番に関係なく合わさるので、同時に書いても衝突しない。
//
// 読み込みは「端末ごとのカーソル」で進める(GoodNotes の同期と同じ考え方: 追記だけのログ + どこまで読んだか)。
//   カーソル = その端末の変更を何番まで読んだか。ファイル名の終了番号がカーソルより大きいファイルだけ読む。
//   (同じ変更が2回届いても op の ID で捨てるので、読み直しになっても害はない)
// さらに、端末のフォルダの ETag(中身が変わると変わる目印)を覚えておき、変わっていないフォルダは中を見ない。
// ETag を返さないサーバーや、ETag の付け方があやしいサーバーのために、起動後の最初・手動・5分ごとの同期では全部のフォルダを見る。
// 全部見たときに「ETag は同じなのに新しいファイルがあった」なら、そのサーバーでは ETag を使わない。

import * as db from './db.js';
import { fileRefs, fileExt } from './model.js';

const FORMAT = 'daigaku-note-ops';
let cfg = {};
let st = { key: '', sentC: 0, cur: {}, tags: {}, sentFiles: [] };
let recorder = null, onRemoteChange = () => {}, onStatus = () => {};
let timer = 0, running = false, again = false, againManual = false, dirsReady = '', lastFull = 0, gapSince = 0;
const FULL_EVERY = 5 * 60_000; // 全部の端末のフォルダを見る間隔
const GAP_WAIT = 2 * 60_000; // 自分の op の番号の抜けが埋まるのを待つ長さ

export const config = () => ({ ...cfg });
const enabled = () => !!(cfg.url && cfg.user);

export async function init(opts) {
  recorder = opts.recorder;
  onRemoteChange = opts.onRemoteChange;
  onStatus = opts.onStatus;
  cfg = (await db.getMeta('dav')) || {};
  const saved = await db.getMeta('davState');
  if (saved && saved.key === stateKey()) st = migrate(saved);
  onStatus(enabled() ? 'クラウド同期: 準備中' : '');
  setInterval(() => { if (enabled() && cfg.auto !== false && document.visibilityState === 'visible') syncNow(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(500); });
  window.addEventListener('online', () => schedule(500));
  if (enabled() && cfg.auto !== false) schedule(1000);
}

const stateKey = () => `${cfg.url}|${cfg.user}`;

// 「ops/<端末>/<開始>-<終了>.json」の終了番号。形が違う名前は null
const rangeOf = (name) => {
  const m = /^(\d+)-(\d+)\.json$/.exec(name);
  return m ? { from: Number(m[1]), end: Number(m[2]) } : null;
};
const endOf = (name) => rangeOf(name)?.end ?? null;
// 送るものを決める。st は sentC と resent だけを見る。
// 以前の版では、GoodNotes の取り込み中に番号を取ってから保存するまでの間に別の op が送られると、取り込んだ op が「送り済み」の
// 後ろに取り残されることがあった。取り込んだ op を持つ端末は、この版で一度だけ、取り込んだ最初の番号から今回の分までを
// 1つのファイルで送り直す(終了番号が読む側のカーソルより大きいので、読む側は読む)。取り込んでいない端末は送り直さない
function planSend(own, fresh, st) {
  if (!fresh.length) return null;
  const to = fresh[fresh.length - 1].c;
  if (!st.resent && st.sentC > 0) {
    // 取り込んだノート: 線などに src: 'goodnotes' の印がある。線のないノート(PDF だけ)は印がないので、
    // 表紙の色を持たない note.create(取り込みで作ったノートの形。手で作ったノートは表紙の色を持つ)も対象にする
    const imported = new Set();
    for (const o of own) {
      if (o.c > st.sentC) break;
      if (o.p && o.p.s && o.p.s.src === 'goodnotes') imported.add(o.n);
      else if (o.t === 'note.create' && !(o.p && o.p.cover)) imported.add(o.n);
    }
    const start = own.find((o) => o.c <= st.sentC && imported.has(o.n));
    if (start) return { from: start.c, to, out: own.filter((o) => o.c >= start.c && o.c <= to), resend: true };
  }
  return { from: st.sentC + 1, to, out: fresh, resend: false };
}
// まだ送っていない自分の op(pending)と、そのうち送り済みの続きから抜けなく並んでいるところ(fresh)。own は番号の順
function unsent(own, sentC) {
  const pending = own.filter((o) => o.c > sentC);
  const fresh = [];
  for (const op of pending) { if (op.c !== sentC + 1 + fresh.length) break; fresh.push(op); }
  return { pending, fresh };
}
// 以前の版の「読んだファイルの一覧」(seen)をカーソルに置き換える。
// 以前の版も開始番号の順に読んでいて、途中で失敗したら止まるので、読んだファイルの終了番号の最大まではすべて読んである
function migrate(s) {
  s.cur = s.cur || {};
  s.tags = s.tags || {};
  if (Array.isArray(s.seen)) {
    for (const path of s.seen) {
      const m = /^ops\/([^/]+)\/([^/]+)$/.exec(path);
      const end = m && endOf(m[2]);
      if (end != null && end > (s.cur[m[1]] || 0)) s.cur[m[1]] = end;
    }
    delete s.seen;
  }
  return s;
}

export async function configure(next) {
  // 同期の途中で設定が変わると、古いサーバーに送った分を新しいサーバーに送ったことにしてしまうので、終わるまで待つ。
  // 通信は時間切れ(dav())で必ず終わるので、待ちは永久には続かない。待ち終えたら設定を変え終わるまで同期を入れない
  while (running) await new Promise((r) => setTimeout(r, 100));
  running = true;
  try {
    const nextCfg = { ...next };
    if (nextCfg.url && !nextCfg.url.endsWith('/')) nextCfg.url += '/';
    const key = `${nextCfg.url}|${nextCfg.user}`;
    const nextSt = st.key === key ? st : { key, sentC: 0, cur: {}, tags: {}, sentFiles: [] };
    // 保存できてからメモリの設定を変える(保存に失敗したときに、メモリと保存の内容がずれないように)
    await db.setMeta('dav', nextCfg);
    await db.setMeta('davState', nextSt);
    if (nextSt !== st) { gapSince = 0; lastFull = 0; }
    cfg = nextCfg;
    st = nextSt;
  } finally {
    running = false;
    again = againManual = false; // 設定のあとはアプリが手動の同期を始める
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

// read: 'json' | 'text' | 'blob' なら本文まで読んで { res, data } を返す(本文の読み込みにも時間切れをかけるため)
async function dav(method, path, { body, headers = {}, ok = [200, 201, 204, 207], read = null } = {}) {
  const auth = 'Basic ' + btoa(unescape(encodeURIComponent(`${cfg.user}:${cfg.pass || ''}`)));
  // 時間切れ: 通信が止まったままだと同期が終わらず、設定の保存も待ち続けるため。大きなファイルを送る・受け取るときは長めに
  const ctl = new AbortController();
  const size = body ? body.size || body.length || 0 : 0;
  let t = setTimeout(() => ctl.abort(), size > 1_000_000 ? 300_000 : 60_000);
  try {
    const res = await fetch(base() + path, { method, body, headers: { Authorization: auth, ...headers }, cache: 'no-store', signal: ctl.signal });
    if (!ok.includes(res.status)) {
      const err = new Error(`${method} ${path || '/'}: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (!read || res.status !== 200 && res.status !== 207) return { res, data: null };
    const len = Number(res.headers.get('Content-Length')) || 0;
    if (len > 1_000_000) { clearTimeout(t); t = setTimeout(() => ctl.abort(), 300_000); }
    return { res, data: await res[read]() };
  } catch (e) {
    if (e.name === 'AbortError') throw new TypeError('時間切れ'); // 接続できないときと同じ扱い
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function mkcol(path) {
  await dav('MKCOL', path, { ok: [201, 405, 301] }); // 405 = すでにある
}

// フォルダの中身。[{ name, tag }](フォルダは名前の末尾に / 、tag は ETag。返さないサーバーでは '')
async function list(path) {
  const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>';
  const { res, data } = await dav('PROPFIND', path, { body, headers: { Depth: '1', 'Content-Type': 'application/xml' }, ok: [207, 404], read: 'text' });
  if (res.status === 404) return [];
  const xml = new DOMParser().parseFromString(data, 'application/xml');
  const self = decodeURIComponent(new URL(base() + path).pathname).replace(/\/+$/, '');
  const out = [];
  for (const r of xml.getElementsByTagNameNS('DAV:', 'response')) {
    const href = r.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent || '';
    const p = decodeURIComponent(new URL(href, base()).pathname);
    const isDir = r.getElementsByTagNameNS('DAV:', 'collection').length > 0 || p.endsWith('/');
    const clean = p.replace(/\/+$/, '');
    if (clean === self) continue;
    // 404 の propstat に入った空の getetag は使わない(値が入っているものだけ)
    let tag = '';
    for (const e of r.getElementsByTagNameNS('DAV:', 'getetag')) if (e.textContent.trim()) tag = e.textContent.trim();
    const name = clean.split('/').pop();
    out.push({ name: isDir ? name + '/' : name, tag });
  }
  return out;
}

// ファイルを手元に持っているか、サーバーから取ってこられたら true
async function fetchFile(ref) {
  if (await db.hasFile(ref.hash)) return true;
  const name = `${ref.hash}.${fileExt(ref.type)}`;
  // 404 以外の失敗(403・500 など)でも、このファイルだけ飛ばして次の同期で取り直す
  const r = await dav('GET', 'files/' + name, { ok: [200, 404], read: 'blob' }).catch((e) => { if (e instanceof TypeError) throw e; return null; });
  if (!r || r.res.status !== 200) return false;
  await db.putFile({ hash: ref.hash, name, type: ref.type, data: new Blob([r.data], { type: ref.type }) });
  return true;
}
function addMissing(ref, n) {
  st.missing = st.missing || [];
  if (!st.missing.some((m) => m.hash === ref.hash)) st.missing.push({ hash: ref.hash, type: ref.type, n });
}

export async function syncNow(manual = false) {
  if (!enabled()) return;
  if (running) { again = true; againManual ||= manual; return; }
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
    // 送るのは「送り済みの番号の続きから、抜けなく並んでいるところまで」。後の番号が先に保存されていることがあり
    // (保存に失敗して番号だけ進んだときなど)、それを先に送ると、前の番号が「送り済み」の後ろに取り残されてしまうため。
    // 抜けが2分たっても埋まらなければ、その番号はもう来ないので、抜けたまま送る。
    const own = (await db.opsByDevice(me)).sort((a, b) => a.c - b.c);
    const { pending, fresh: ready } = unsent(own, st.sentC);
    let fresh = ready;
    if (fresh.length < pending.length) {
      if (!gapSince) gapSince = Date.now();
      if (Date.now() - gapSince >= GAP_WAIT) { fresh = pending; gapSince = 0; }
    } else gapSince = 0;
    let sent = 0;
    const put = async (plan) => {
      for (const op of plan.out) {
        for (const ref of fileRefs(op)) {
          if (st.sentFiles.includes(ref.hash)) continue;
          const name = `files/${ref.hash}.${fileExt(ref.type)}`;
          const head = await dav('HEAD', name, { ok: [200, 404] });
          if (head.res.status === 404) {
            const f = await db.getFile(ref.hash);
            if (f) await dav('PUT', name, { body: f.data, headers: { 'Content-Type': ref.type } });
          }
          st.sentFiles.push(ref.hash);
        }
      }
      const body = JSON.stringify({ format: FORMAT, version: 1, device: me, ops: plan.out });
      await dav('PUT', `ops/${me}/${String(plan.from).padStart(9, '0')}-${String(plan.to).padStart(9, '0')}.json`, { body, headers: { 'Content-Type': 'application/json' } });
    };
    let plan = planSend(own, fresh, st);
    if (plan && plan.resend) {
      // 送り直しは大きくなりうる。失敗したら(大きすぎて断られた・時間切れなど。ブラウザでは理由が分からないことも多い)
      // 今回はふつうに送る。3回失敗したら送り直しはあきらめる
      try { await put(plan); } catch (e) {
        console.warn('送り直しに失敗しました', e);
        st.resendTries = (st.resendTries || 0) + 1;
        if (st.resendTries >= 3) st.resent = true;
        await db.setMeta('davState', st);
        plan = planSend(own, fresh, { ...st, resent: true });
        await put(plan); // 接続できないなら、ここで同期全体が失敗する(次の同期でもう一度)
        st.sentC = plan.to; // 続きは送れた。送り直しは次の同期でもう一度(3回まで)
        sent = fresh.length;
        await db.setMeta('davState', st);
        plan = null;
      }
    } else if (plan) await put(plan);
    if (plan) {
      st.sentC = plan.to;
      st.resent = true;
      sent = fresh.length;
      await db.setMeta('davState', st);
    } else if (!st.resent && st.sentC === 0) {
      st.resent = true; // 一度も送っていない端末には取り残しはない
      await db.setMeta('davState', st);
    }
    if (gapSince) schedule(15_000); // 抜けが埋まったか、また見に来る

    // 2) ほかの端末の変更を読み込む(端末ごとに、カーソルより後のファイルだけを終了番号の順に)
    const full = manual || !lastFull || Date.now() - lastFull >= FULL_EVERY;
    const changed = new Set();
    let got = 0, newer = false, broken = false, suspicious = false, trustworthy = false;
    for (const { name: dir, tag } of await list('ops/')) {
      if (!dir.endsWith('/') || dir === me + '/') continue;
      const dev = dir.slice(0, -1);
      const sameTag = !!tag && st.tags[dev] === tag;
      if (!full && sameTag && !st.etagBad) continue; // 前に見たときから変わっていない
      const files = (await list(`ops/${dir}`))
        .map((f) => ({ name: f.name, ...rangeOf(f.name) }))
        .filter((f) => f.end != null && f.end > (st.cur[dev] || 0))
        .sort((a, b) => a.end - b.end || a.from - b.from);
      let read = 0, stopped = false;
      for (const f of files) {
        if (f.end <= (st.cur[dev] || 0)) continue; // 同じ範囲を先に読んだ
        let json;
        try {
          json = (await dav('GET', `ops/${dir}${f.name}`, { read: 'json' })).data;
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
          // 書き込みの途中で切れた壊れたファイル。同じ範囲をふくむ後のファイルがあればそちらで読む
          if (files.some((g) => g !== f && g.from <= f.from && g.end >= f.end)) continue;
          // この端末はここで止める(ほかの端末は続ける)。次の同期でまた試し、20回読めなければあきらめて先へ進む
          // (20回以上、かつ最初に失敗してから1日たったら。書いた端末が同じ名前で書き直すのを待つため)
          const key = `${dev}/${f.name}`;
          st.badTries = st.badTries || {};
          const bt = (st.badTries[key] = st.badTries[key] || { n: 0, since: Date.now() });
          bt.n++;
          if (bt.n < 20 || Date.now() - bt.since < 86_400_000) { broken = stopped = true; await db.setMeta('davState', st); break; }
          delete st.badTries[key];
          st.lost = (st.lost || 0) + 1;
          st.cur[dev] = f.end;
          await db.setMeta('davState', st);
          continue;
        }
        if (!json || json.format !== FORMAT || !(json.version <= 1)) {
          newer = stopped = true; // 新しい版のアプリが書いた形。読んだことにはせず、アプリの更新を待つ
          break;
        }
        const ops = (json.ops || []).filter((o) => o && typeof o.id === 'string' && typeof o.l === 'number' && o.n && o.t);
        for (const op of ops) {
          for (const ref of fileRefs(op)) {
            if (!(await fetchFile(ref))) addMissing(ref, op.n);
          }
          recorder.observe(op);
        }
        got += await db.putOps(ops, recorder.clock);
        for (const op of ops) changed.add(op.n);
        st.cur[dev] = f.end;
        if (st.badTries) for (const k of Object.keys(st.badTries)) if (k.startsWith(dev + '/')) delete st.badTries[k];
        read++;
        await db.setMeta('davState', st);
      }
      // ETag が前と同じなのに新しいファイルがあった: このサーバーの ETag は当てにならないかもしれない
      if (sameTag && read) suspicious = true;
      else if (tag && !sameTag && read) trustworthy = true;
      // 最後まで読めたときだけ目印を覚える(途中で止まったら次も中を見る)
      if (tag && !stopped && st.tags[dev] !== tag) { st.tags[dev] = tag; await db.setMeta('davState', st); }
    }
    if (full) {
      lastFull = Date.now();
      // 全部見る回で2回続けて「ETag が同じなのに新しいファイル」なら、以後は ETag を使わない
      // (1回で決めないのは、ETag を少し遅れて更新するサーバーもあるため)
      // 数を戻すのは「ETag が変わっていて新しいファイルもあった」(ETag が正しく働いた)ときだけ
      const sus = suspicious ? (st.etagSus || 0) + 1 : trustworthy ? 0 : st.etagSus || 0;
      if (sus !== (st.etagSus || 0)) {
        st.etagSus = sus;
        if (sus >= 2) st.etagBad = true;
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
    let note = '';
    if (newer) note = '。ほかの端末が新しい版の大学ノートで書いた変更があります。アプリを更新してください';
    else if (broken) note = '。ほかの端末の変更のファイルに読めないものがありました。次の同期で読み直します';
    else if (st.lost && manual) {
      note = `。ほかの端末の変更のファイルのうち ${st.lost} 個が壊れていて読めませんでした`;
      st.lost = 0; // 一度知らせたら消す
      await db.setMeta('davState', st);
    }
    if (gapSince) note += '。保存の終わっていない変更があるので、送るのを少し待っています';
    onStatus(`クラウド同期: ${time} に同期しました` + (manual ? `(送信 ${sent}件・受信 ${got}件)` : '') + note);
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
    if (again) {
      const m = againManual;
      again = againManual = false;
      if (m) setTimeout(() => syncNow(true), 0); // 手動の同期は、待たせたあとも手動として(全部のフォルダを見る)
      else schedule(1000);
    }
  }
}

// テスト用
export const _test = { migrate, endOf, rangeOf, unsent, planSend };
