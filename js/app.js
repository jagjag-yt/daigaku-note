import * as db from './db.js';
import {
  Recorder, emptyNote, applyOp, pagesOf, strokesOf, buildLibrary, newId, strokeHit, styleOf, bgOf, PAGE_A4,
} from './model.js';
import { drawStroke, recognizeShape, strokeInLasso, geometry, strokeSvg } from './ink.js';
import { TEMPLATES, SIZES, templatePrims, sizeById } from './templates.js';
import { importPdf, renderPdfPage, exportPdf } from './pdf.js';
import { buildSyncFile, importSyncFile } from './sync.js';
import * as search from './search.js';
import * as dav from './webdav.js';
import { icon, fillIcons, openPopover, closePopover, menu, retargetPopover } from './ui.js';

const $ = (s) => document.querySelector(s);
// 色と太さは道具ごとに3つずつ「よく使うもの」として並べる。選んでいるものをもう一度押すと入れ替えられる
const PEN_COLORS = ['#1f2937', '#2563eb', '#dc2626'];
const MARKER_COLORS = ['#fde047', '#86efac', '#f9a8d4'];
const PEN_WIDTHS = [1.2, 2.2, 4];
const MARKER_WIDTHS = [8, 14, 22];
const PEN_PALETTE = [
  '#000000', '#1f2937', '#4b5563', '#9ca3af', '#ffffff',
  '#1e3a8a', '#2563eb', '#0ea5e9', '#0d9488', '#16a34a',
  '#65a30d', '#ca8a04', '#f59e0b', '#ea580c', '#dc2626',
  '#be185d', '#db2777', '#9333ea', '#6d28d9', '#78350f',
];
const MARKER_PALETTE = [
  '#fde047', '#fef08a', '#fdba74', '#fca5a5', '#f9a8d4',
  '#d8b4fe', '#a5b4fc', '#93c5fd', '#67e8f9', '#86efac',
  '#bef264', '#d1d5db',
];
const WIDTH_RANGE = { pen: [0.5, 8, 0.1], marker: [4, 32, 1] };
const COVERS = ['#2f5d9e', '#b33a3a', '#2f7d5b', '#7a4fa0', '#c27c1a', '#3a6f7a', '#4b5563', '#a8556f'];
const COVER_NAMES = ['紺', '赤', '緑', '紫', '黄土', '青緑', '灰', '桃'];
const MAX_CANVAS_PX = 4_000_000; // iPad Safari のキャンバス上限を避ける

const S = {
  rec: null,
  note: null,
  zoom: 1,
  tool: 'pen', // pen | marker | eraser | lasso
  pen: { color: PEN_COLORS[0], width: PEN_WIDTHS[1] },
  marker: { color: MARKER_COLORS[0], width: MARKER_WIDTHS[1] },
  slots: {
    pen: { colors: [...PEN_COLORS], widths: [...PEN_WIDTHS] },
    marker: { colors: [...MARKER_COLORS], widths: [...MARKER_WIDTHS] },
  },
  sidebar: false,
  eraser: { si: 1, markerOnly: false },
  fit: true, // 幅に合わせた拡大率のままか(手で拡大したら false)
  fingerDraw: false,
  shapes: true,
  undo: [],
  redo: [],
  views: new Map(), // pageId -> view
  io: null,
  sel: null, // 投げ縄で選んだ線 { pageId, ids:Set, box }
};

// ---------- 起動 ----------
async function init() {
  let device = await db.getMeta('device');
  if (!device) {
    device = newId(8);
    await db.setMeta('device', device);
  }
  const clock = (await db.getMeta('clock')) || { c: 0, l: 0 };
  S.rec = new Recorder(device, clock.c, clock.l);
  const prefs = (await db.getMeta('prefs')) || {};
  if (prefs.fingerDraw) S.fingerDraw = true;
  if (prefs.shapes === false) S.shapes = false;
  if (prefs.pen) S.pen = prefs.pen;
  if (prefs.marker) S.marker = prefs.marker;
  if (prefs.sidebar) S.sidebar = true;
  for (const k of ['pen', 'marker']) {
    const sl = prefs.slots?.[k];
    if (sl && sl.colors?.length === 3 && sl.widths?.length === 3) S.slots[k] = sl;
    // 前の版で選んでいた色・太さが並びになければ、先頭に入れておく
    if (!S.slots[k].colors.includes(S[k].color)) S.slots[k].colors[0] = S[k].color;
    if (!S.slots[k].widths.includes(S[k].width)) S.slots[k].widths[0] = S[k].width;
    // 選んでいるのは何番目の枠か(同じ色が2つの枠に入っていても区別できるように)
    if (!(S[k].ci >= 0 && S.slots[k].colors[S[k].ci] === S[k].color)) S[k].ci = S.slots[k].colors.indexOf(S[k].color);
    if (!(S[k].wi >= 0 && S.slots[k].widths[S[k].wi] === S[k].width)) S[k].wi = S.slots[k].widths.indexOf(S[k].width);
  }
  if (prefs.eraser) S.eraser = { ...S.eraser, ...prefs.eraser };
  if (['pen', 'marker', 'eraser', 'lasso'].includes(prefs.tool)) S.tool = prefs.tool;

  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    // 新しい版が入ったら、書いている最中でなければ読み込み直して切り替える(書いた線は保存済み)
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      const tryReload = () => (active || penPending ? setTimeout(tryReload, 500) : location.reload());
      tryReload();
    });
  }
  fillIcons();
  bindDialogs();
  fillSelects();
  bindLibrary();
  buildToolbar();
  bindEditor();
  await dav.init({ recorder: S.rec, onRemoteChange: onRemoteChange, onStatus: setSyncStatus });
  search.init({ onProgress: (msg) => { const el = $('#search-status'); if (el) el.textContent = msg; } });
  window.addEventListener('hashchange', route);
  route();
}

function savePrefs() {
  db.setMeta('prefs', { fingerDraw: S.fingerDraw, shapes: S.shapes, pen: S.pen, marker: S.marker, slots: S.slots, sidebar: S.sidebar, eraser: S.eraser, tool: S.tool });
}

function route() {
  flushPen();
  closePopover();
  if (!$('#toast-act').hidden) $('#toast').hidden = true; // 「元に戻す」付きのトーストだけ、画面が変わったら消す
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  const m = location.hash.match(/^#\/note\/(\w+)(?:\/p\/(\w+))?/);
  if (m) openNote(m[1], m[2]);
  else showLibrary();
}

// action: { label, run } を渡すと「元に戻す」などのボタンを付ける
function toast(msg, ms = 2500, action) {
  const t = $('#toast');
  $('#toast-msg').textContent = msg;
  const b = $('#toast-act');
  b.hidden = !action;
  if (action) {
    b.textContent = action.label;
    b.onclick = () => { t.hidden = true; action.run(); };
    ms = Math.max(ms, 5000);
  }
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

const coarse = () => matchMedia('(pointer: coarse)').matches;
// ダイアログを開く。iPad などでは勝手にキーボードを出さない
function showDialog(d, focusEl) {
  d.showModal();
  if (coarse()) { d.focus(); } else if (focusEl) { focusEl.focus(); focusEl.select?.(); }
}
// どのダイアログにも右上の × と、背景を押したら閉じる動きを付ける
function bindDialogs() {
  for (const d of document.querySelectorAll('dialog')) {
    d.tabIndex = -1;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'dlg-close icon-btn small';
    x.setAttribute('aria-label', '閉じる');
    x.innerHTML = icon('close', 18);
    x.onclick = () => d.close();
    d.prepend(x);
    d.addEventListener('pointerdown', (e) => { d._downOnBackdrop = e.target === d; });
    d.addEventListener('click', (e) => {
      if (e.target !== d || !d._downOnBackdrop) return;
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
    });
  }
}

// 名前を入力してもらう(ブラウザ標準の prompt の代わり)
function askName(heading, value) {
  return new Promise((resolve) => {
    const d = $('#rename-dialog'), inp = $('#rename-input');
    $('#rename-heading').textContent = heading;
    inp.value = value || '';
    let result = null;
    $('#rename-form').onsubmit = (e) => { e.preventDefault(); result = inp.value.trim(); d.close(); };
    $('#rename-cancel').onclick = () => d.close();
    d.addEventListener('close', () => resolve(result), { once: true });
    d.showModal();
    inp.focus();
    inp.select();
  });
}

function download(data, name, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const safeName = (s) => (s || 'ノート').replace(/[\\/:*?"<>|]/g, '_');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fillSelects() {
  for (const sel of document.querySelectorAll('select.tpl-select')) {
    sel.innerHTML = TEMPLATES.map((t) => `<option value="${t.id}">${t.label}</option>`).join('');
    sel.value = 'lines-b';
  }
  for (const sel of document.querySelectorAll('select.size-select')) {
    sel.innerHTML = SIZES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
  }
  $('#pp-size').insertAdjacentHTML('afterbegin', '<option value="">今のページと同じ</option>');
  $('#pp-size').value = '';
  tplPicker($('#nn-tpl'), 'lines-b');
  tplPicker($('#pp-tpl'), 'lines-b');
  $('#nn-size').onchange = () => tplPicker($('#nn-tpl'), $('#nn-tpl').dataset.value, sizeById($('#nn-size').value));
  $('#pp-size').onchange = () => tplPicker($('#pp-tpl'), $('#pp-tpl').dataset.value, $('#pp-size').value ? sizeById($('#pp-size').value) : addRef || PAGE_A4);
  coverPicker($('#nn-cover'), COVERS[0]);
}

// 用紙(テンプレート)を見本の絵で選ぶ。選んだ値は el.dataset.value
// size: { w, h } 見本の縦横比(選んだ用紙サイズに合わせる)
function tplPicker(el, value, size = PAGE_A4) {
  el.innerHTML = '';
  const { w, h } = size;
  // 見本は小さいので、罫線を画面で 1px 以上の太さにして見分けられるようにする
  const minW = (w / 100) * 0.8;
  for (const t of TEMPLATES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tpl-opt';
    b.dataset.tpl = t.id;
    b.setAttribute('role', 'radio');
    b.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="--ar:${w} / ${h}" preserveAspectRatio="none" aria-hidden="true">${templateSvg({ type: 'blank', ruling: t.id }, w, h, minW)}</svg><span></span>`;
    b.querySelector('span').textContent = t.label;
    b.onclick = () => setPick(el, t.id);
    el.appendChild(b);
  }
  setPick(el, value);
}
function setPick(el, value) {
  el.dataset.value = value;
  for (const b of el.children) {
    const on = (b.dataset.tpl || b.dataset.cover) === value;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  }
}
function coverPicker(el, value, onPick) {
  el.innerHTML = '';
  for (const c of COVERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cover-opt';
    b.dataset.cover = c;
    b.style.setProperty('--cover', c);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', '表紙の色: ' + COVER_NAMES[COVERS.indexOf(c)]);
    b.title = COVER_NAMES[COVERS.indexOf(c)];
    b.onclick = () => { setPick(el, c); onPick?.(c); };
    el.appendChild(b);
  }
  setPick(el, value);
}

// ---------- op の記録 ----------
function mk(t, p, n = S.note.id) {
  return S.rec.make(n, t, p);
}
async function commit(ops) {
  for (const op of ops) if (S.note && op.n === S.note.id) applyOp(S.note, op);
  try {
    await db.putOps(ops, S.rec.clock);
    setSaved(true);
    dav.schedule();
    if (S.note) for (const op of ops) if (op.t === 'page.add') search.markDirty(S.note.id, op.p.page.id);
    if (S.note) thumbsDirty(ops);
  } catch (e) {
    setSaved(false);
    toast('保存に失敗しました: ' + e.message, 6000);
  }
}
// 線が変わったページのサムネイルを少し後で描き直す
const dirtyThumbs = new Set();
let thumbTimer = 0;
function thumbsDirty(ops) {
  if (!S.sidebar || !S.thumbs?.size) return;
  for (const op of ops) {
    const p = op.p || {};
    if (op.t === 'stroke.add') dirtyThumbs.add(p.s.pageId);
    const ids = p.ids || Object.keys(p.tf || p.styles || {});
    for (const id of ids) { const d = S.note.strokes.get(id)?.data; if (d) dirtyThumbs.add(d.pageId); }
  }
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(function run() {
    // 書いている最中は描き直さない(ペンの動きを邪魔しない)
    if (active || penPending) { thumbTimer = setTimeout(run, 600); return; }
    for (const id of dirtyThumbs) {
      const row = S.thumbs.get(id), pg = S.note && pagesOf(S.note).find((x) => x.id === id);
      if (row && pg && row.dataset.drawn) drawThumb(row.querySelector('canvas'), pg);
    }
    dirtyThumbs.clear();
  }, 600);
}

function setSaved(ok) {
  const el = $('#saved');
  if (el) el.textContent = ok ? '端末に保存済み' : '保存エラー';
}
function setSyncStatus(msg) {
  for (const el of document.querySelectorAll('.sync-status')) el.textContent = msg;
  const bad = /失敗|エラー|できません/.test(msg || '');
  $('.sync-dot').hidden = !bad;
  $('#sync-btn').title = bad ? '同期: ' + msg : '同期';
}

// 他の端末の変更が届いたとき
async function onRemoteChange(noteIds) {
  for (const n of noteIds) search.markNoteDirty(n);
  if (S.note && noteIds.has(S.note.id)) {
    const top = $('#scroller').scrollTop;
    const ops = await db.opsForNote(S.note.id);
    const note = emptyNote(S.note.id);
    for (const op of ops) applyOp(note, op);
    S.note = note;
    $('#title').textContent = note.title;
    renderPages();
    $('#scroller').scrollTop = top;
  } else if (!$('#library').hidden) {
    showLibrary();
  }
}

// ---------- ノート一覧 ----------
function bindLibrary() {
  const newNote = () => {
    $('#nn-title').value = '';
    setPick($('#nn-cover'), COVERS[Math.floor(Math.random() * COVERS.length)]);
    showDialog($('#new-dialog'), $('#nn-title'));
  };
  // 「新規」: ノートを作るか、ファイルを読み込むかを選ぶ
  S.newMenu = (anchor) => openPopover(anchor, (body, close) => menu(body, [
    { icon: 'notebook', label: 'ノート', id: 'new-notebook', onClick: newNote },
    { icon: 'pdf', label: 'PDF を読み込む', id: 'open-pdf', onClick: () => $('#pdf-input').click() },
    { icon: 'import', label: 'GoodNotes から取り込む(.goodnotes)', id: 'open-gn', onClick: () => $('#gn-input').click() },
  ], close), { className: 'new-menu' });
  $('#nn-cancel').onclick = () => $('#new-dialog').close();
  $('#new-form').onsubmit = async (e) => {
    e.preventDefault();
    const title = $('#nn-title').value.trim() || '無題のノート';
    const size = sizeById($('#nn-size').value);
    const ruling = $('#nn-tpl').dataset.value;
    const cover = $('#nn-cover').dataset.value;
    const id = newId();
    const ops = [
      S.rec.make(id, 'note.create', { title, cover }),
      S.rec.make(id, 'page.add', { page: { id: newId(), w: size.w, h: size.h, order: 1, bg: { type: 'blank', ruling } } }),
    ];
    await db.putOps(ops, S.rec.clock);
    dav.schedule();
    $('#new-dialog').close();
    location.hash = '#/note/' + id;
  };
  $('#pdf-input').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      toast('PDFを読み込んでいます…', 60000);
      const { hash, sizes } = await importPdf(file);
      const id = newId();
      const ops = [S.rec.make(id, 'note.create', { title: file.name.replace(/\.pdf$/i, '') })];
      sizes.forEach((sz, i) => ops.push(S.rec.make(id, 'page.add', { page: { id: newId(), w: sz.w, h: sz.h, order: i + 1, bg: { type: 'pdf', hash, page: i + 1 } } })));
      await db.putOps(ops, S.rec.clock);
      dav.schedule();
      for (const op of ops.slice(1)) search.markDirty(id, op.p.page.id);
      toast(`${sizes.length}ページのPDFを読み込みました`);
      location.hash = '#/note/' + id;
    } catch (err) {
      toast('PDFを読み込めませんでした: ' + err.message, 6000);
    }
  };
  $('#gn-input').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const file of files) {
      try {
        toast(`「${file.name}」を読み込んでいます…`, 120000);
        const { importGoodnotes } = await import('./goodnotes.js');
        const r = await importGoodnotes(file, S.rec);
        dav.schedule();
        for (const pid of r.pageIds) search.markDirty(r.noteId, pid);
        toast(`「${r.title}」を取り込みました(${r.pages}ページ、手書き${r.strokes}本)`, 5000);
        if (files.length === 1) location.hash = '#/note/' + r.noteId;
        else showLibrary();
      } catch (err) {
        console.error(err);
        toast(`「${file.name}」を取り込めませんでした: ${err.message}`, 8000);
      }
    }
  };
  $('#sync-btn').onclick = async () => {
    $('#device-id').textContent = S.rec.device;
    const cfg = dav.config();
    $('#dav-url').value = cfg.url || '';
    $('#dav-user').value = cfg.user || '';
    $('#dav-pass').value = cfg.pass || '';
    $('#dav-auto').checked = cfg.auto !== false;
    showDialog($('#sync-dialog'));
  };
  $('#sync-close').onclick = () => $('#sync-dialog').close();
  $('#dav-form').onsubmit = async (e) => {
    e.preventDefault();
    await dav.configure({ url: $('#dav-url').value.trim(), user: $('#dav-user').value.trim(), pass: $('#dav-pass').value, auto: $('#dav-auto').checked });
    await dav.syncNow(true);
  };
  $('#dav-off').onclick = async () => {
    await dav.configure({ url: '', user: '', pass: '', auto: false });
    setSyncStatus('クラウド同期はオフです');
  };
  $('#sync-export').onclick = async () => {
    const json = await buildSyncFile(S.rec.device);
    download(JSON.stringify(json), `大学ノート同期-${S.rec.device}-${stamp()}.json`, 'application/json');
    toast(`${json.ops.length}件の変更を書き出しました`);
  };
  $('#sync-import').onclick = () => $('#sync-input').click();
  $('#sync-input').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    let added = 0, total = 0;
    try {
      for (const f of files) {
        const r = await importSyncFile(JSON.parse(await f.text()), S.rec);
        added += r.added;
        total += r.total;
        for (const n of r.notes) search.markNoteDirty(n);
      }
      toast(added ? `${added}件の新しい変更を取り込みました(全${total}件)` : 'すべて取り込み済みでした');
      $('#sync-dialog').close();
      dav.schedule();
      route();
    } catch (err) {
      toast('取り込めませんでした: ' + err.message, 6000);
    }
  };
  let qTimer;
  $('#search').oninput = () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(runSearch, 200);
  };
}

let searchSeq = 0;
async function runSearch() {
  const seq = ++searchSeq;
  const q = $('#search').value.trim();
  const box = $('#results');
  if (!q) {
    box.hidden = true;
    $('#notes').hidden = false;
    return;
  }
  const lib = buildLibrary(await db.noteLevelOps());
  const live = new Map([...lib.values()].filter((n) => !n.deleted && n.titleS).map((n) => [n.id, n]));
  const hits = await search.query(q, live);
  if (seq !== searchSeq) return; // もっと新しい検索が始まっている
  box.hidden = false;
  $('#notes').hidden = true;
  if (!hits.length) {
    box.innerHTML = `<p class="empty">「${esc(q)}」は見つかりませんでした。</p>`;
    return;
  }
  box.innerHTML = hits.slice(0, 100).map((h) => `
    <a class="hit" href="#/note/${h.noteId}${h.pageId ? '/p/' + h.pageId : ''}">
      <span class="hit-title">${h.pageId ? esc(h.title) : h.snippet}${h.pageNo ? ` <span class="hit-page">${h.pageNo}ページ目</span>` : ''}</span>
      ${h.pageId ? `<span class="hit-snip">${h.snippet}</span>` : ''}
      <span class="hit-src">${h.source}</span>
    </a>`).join('');
}

function coverColor(n) {
  if (n.cover) return n.cover;
  let h = 0;
  for (const ch of n.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COVERS[h % 6]; // 表紙を選べるようになる前のノートは、前と同じ6色から決める
}

const fmtDate = (t) => {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return '今日 ' + d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ja-JP', d.getFullYear() === now.getFullYear() ? { month: 'long', day: 'numeric' } : { dateStyle: 'medium' });
};

async function showLibrary() {
  closeEditor();
  closePopover();
  $('#library').hidden = false;
  $('#editor').hidden = true;
  document.title = '大学ノート';
  const [ops, metas] = await Promise.all([db.noteLevelOps(), db.allNoteMeta()]);
  const lib = buildLibrary(ops);
  const upd = new Map(metas.map((m) => [m.id, m.updatedAt]));
  const notes = [...lib.values()].filter((n) => !n.deleted && n.titleS).sort((a, b) => (upd.get(b.id) || 0) - (upd.get(a.id) || 0));
  const grid = $('#notes');
  grid.innerHTML = '';
  $('#empty').hidden = notes.length > 0;
  // 先頭は「新規」
  const nt = document.createElement('div');
  nt.className = 'card new-card';
  nt.innerHTML = `<button id="new-note" class="cover new-cover" aria-haspopup="menu">${icon('plus', 40)}</button><div class="meta"><div class="name">新規</div></div>`;
  nt.querySelector('#new-note').onclick = (e) => S.newMenu(e.currentTarget);
  grid.appendChild(nt);
  for (const n of notes) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <a class="cover" href="#/note/${n.id}" style="--cover:${coverColor(n)}">
        <span class="label"><span class="label-title"></span></span>
      </a>
      <div class="meta">
        <button class="name-btn" aria-haspopup="menu" title="ノートの操作"><span class="name"></span>${icon('chevron', 16)}</button>
        <div class="date"></div>
      </div>`;
    card.querySelector('.label-title').textContent = n.title;
    card.querySelector('.name').textContent = n.title;
    card.querySelector('.date').textContent = fmtDate(upd.get(n.id));
    const nb = card.querySelector('.name-btn');
    nb.onclick = () => noteMenu(nb, n);
    longPress(card.querySelector('.cover'), () => noteMenu(nb, n));
    grid.appendChild(card);
  }
  if ($('#search').value.trim()) runSearch();
}

// 長押し(指・ペン)と右クリックでメニューを出す。長押しのあとの「開く」は止める
function longPress(el, fn) {
  let timer = 0, start = null, fired = false;
  el.addEventListener('pointerdown', (e) => {
    fired = false;
    if (e.pointerType === 'mouse') return;
    start = [e.clientX, e.clientY];
    timer = setTimeout(() => { fired = true; navigator.vibrate?.(10); fn(); }, 480);
  });
  el.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 10) { clearTimeout(timer); start = null; }
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(t, () => { clearTimeout(timer); start = null; });
  // 先に登録しておけば、長押しのあとの click を後の onclick より先に止められる
  el.addEventListener('click', (e) => { if (fired) { e.preventDefault(); e.stopImmediatePropagation(); fired = false; } });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!fired) fn(); });
}

function noteMenu(anchor, n) {
  const covers = document.createElement('div');
  covers.className = 'menu-covers';
  covers.innerHTML = '<div class="menu-cap">表紙の色</div><div class="cover-pick small"></div>';
  coverPicker(covers.querySelector('.cover-pick'), coverColor(n), async (c) => {
    await db.putOps([S.rec.make(n.id, 'note.cover', { cover: c })], S.rec.clock);
    dav.schedule();
    closePopover();
    showLibrary();
  });
  openPopover(anchor, (body, close) => menu(body, [
    { icon: 'rename', label: '名前を変更', attrs: { 'data-act': 'rename' }, onClick: async () => {
      const title = await askName('名前を変更', n.title);
      if (!title || title === n.title) return;
      await db.putOps([S.rec.make(n.id, 'note.rename', { title })], S.rec.clock);
      dav.schedule();
      showLibrary();
    } },
    { icon: 'export', label: '同期ファイルとして書き出す', attrs: { 'data-act': 'export' }, onClick: async () => {
      const json = await buildSyncFile(S.rec.device, n.id);
      download(JSON.stringify(json), `${safeName(n.title)}.daigaku.json`, 'application/json');
    } },
    '-',
    { el: covers },
    '-',
    { icon: 'trash', label: '削除', danger: true, attrs: { 'data-act': 'delete' }, onClick: async () => {
      await db.putOps([S.rec.make(n.id, 'note.delete', {})], S.rec.clock);
      dav.schedule();
      showLibrary();
      toast(`「${n.title}」を削除しました`, 6000, { label: '元に戻す', run: async () => {
        await db.putOps([S.rec.make(n.id, 'note.restore', {})], S.rec.clock);
        dav.schedule();
        if (!$('#library').hidden) showLibrary();
      } });
    } },
  ], close), { align: 'start' });
}

// ---------- エディタのツールバー ----------
const ERASER_SIZES = [5, 10, 22]; // 画面上の半径(px)
const narrow = () => window.innerWidth <= 520;
const inkTool = () => (S.tool === 'marker' ? 'marker' : 'pen');
const toolState = () => S[inkTool()];

// ツールバーのボタンは最初に作って使い回す(作り直すと、開いているポップオーバーの位置がずれるため)
function buildToolbar() {
  const sw = $('#colors'), ws = $('#widths');
  for (let i = 0; i < 3; i++) {
    const c = document.createElement('button');
    c.className = 'swatch';
    c.onclick = () => onColorSlot(c, i);
    sw.appendChild(c);
    const w = document.createElement('button');
    w.className = 'width';
    w.innerHTML = '<span></span>';
    w.onclick = () => onWidthSlot(w, i);
    ws.appendChild(w);
  }
  // 消しゴムのときは、色の場所に「蛍光ペンだけ消す」のスイッチを出す
  const em = document.createElement('button');
  em.id = 'eraser-marker';
  em.className = 'chip';
  em.innerHTML = `${icon('marker', 18)}<span>蛍光ペンだけ</span>`;
  em.title = 'オンにすると、蛍光ペンの線だけを消します';
  em.onclick = () => {
    S.eraser.markerOnly = !S.eraser.markerOnly;
    savePrefs();
    refreshToolbar();
  };
  sw.appendChild(em);
}

function refreshToolbar() {
  for (const t of ['pen', 'marker', 'eraser', 'lasso']) {
    const b = $('#tool-' + t);
    b.classList.toggle('on', S.tool === t);
    b.setAttribute('aria-pressed', S.tool === t);
  }
  $('#tool-pen').style.setProperty('--tc', S.pen.color);
  $('#tool-marker').style.setProperty('--tc', S.marker.color);
  const sh = $('#shapes');
  sh.classList.toggle('on', S.shapes);
  sh.setAttribute('aria-pressed', S.shapes);
  sh.disabled = S.tool !== 'pen' && S.tool !== 'marker';
  const er = $('#tool-eraser');
  er.classList.toggle('marker-only', !!S.eraser.markerOnly);
  er.title = S.eraser.markerOnly ? '消しゴム(蛍光ペンだけ消す) (E)' : '消しゴム (E)';
  const em = $('#eraser-marker');
  em.classList.toggle('on', !!S.eraser.markerOnly);
  em.setAttribute('aria-pressed', !!S.eraser.markerOnly);
  $('#undo').disabled = !S.undo.length;
  $('#redo').disabled = !S.redo.length;
  $('#pages-btn').classList.toggle('on', S.sidebar);
  const eraser = S.tool === 'eraser', lasso = S.tool === 'lasso';
  const k = inkTool(), st = toolState(), sl = S.slots[k];
  // 色: 消しゴムでは出さない(場所は残して、道具のボタンが横に動かないようにする)。
  // 投げ縄では、選んだ線の色を変えるのに使う(選んでいないときは押せない)
  $('#colors').classList.toggle('eraser-mode', eraser);
  $('#sep-widths').classList.toggle('invisible', lasso);
  $('#widths').classList.toggle('invisible', lasso);
  [...$('#colors').querySelectorAll('.swatch')].forEach((b, i) => {
    const c = sl.colors[i], on = !lasso && i === st.ci;
    b.style.setProperty('--c', c);
    b.classList.toggle('on', on);
    b.disabled = lasso && !S.sel;
    b.title = lasso ? '選んだ線をこの色にする' : on ? '色を変える' : '色';
    b.setAttribute('aria-label', (lasso ? '選んだ線の色: ' : on ? '色(もう一度押すと変更): ' : '色: ') + colorName(c));
    b.setAttribute('aria-pressed', on);
  });
  [...$('#widths').children].forEach((b, i) => {
    let px, on, label;
    if (eraser) {
      on = i === S.eraser.si;
      px = [8, 14, 24][i]; // 消える範囲(直径 10/20/44px)の大小が分かる大きさ
      label = ['小さい消しゴム', '中くらいの消しゴム', '大きい消しゴム'][i];
      b.style.setProperty('--wc', 'transparent');
      b.classList.add('ring');
    } else {
      const [lo, hi] = WIDTH_RANGE[k], w = sl.widths[i];
      on = i === st.wi;
      // 見た目の太さは 4〜16px に収める
      px = 4 + Math.round(((w - lo) / (hi - lo)) * 12);
      label = `太さ ${w}pt`;
      b.style.setProperty('--wc', k === 'marker' ? st.color + '99' : st.color);
      b.classList.remove('ring');
    }
    b.classList.toggle('on', on);
    b.firstChild.style.width = b.firstChild.style.height = px + 'px';
    b.title = on && !eraser ? '太さを変える' : label;
    b.setAttribute('aria-label', on && !eraser ? label + '(もう一度押すと変更)' : label);
    b.setAttribute('aria-pressed', on);
  });
}

function onColorSlot(b, i) {
  const k = inkTool();
  if (S.tool === 'lasso') {
    if (S.sel) recolorSelection(S.slots.pen.colors[i]);
    return;
  }
  if (S.tool === 'eraser') return;
  if (S[k].ci === i) return colorPopover(b, k, i);
  closePopover();
  S[k].ci = i;
  S[k].color = S.slots[k].colors[i];
  savePrefs();
  refreshToolbar();
}

function onWidthSlot(b, i) {
  // スマホ幅では選択中の1つだけ見せているので、押したら候補を出す
  if (narrow() && b.classList.contains('on')) return S.tool === 'eraser' ? eraserSizePopover(b) : widthPopover(b, inkTool(), i);
  if (S.tool === 'eraser') {
    S.eraser.si = i;
    savePrefs();
    return refreshToolbar();
  }
  const k = inkTool();
  if (S[k].wi === i) return widthPopover(b, k, i);
  closePopover();
  S[k].wi = i;
  S[k].width = S.slots[k].widths[i];
  savePrefs();
  refreshToolbar();
}

const COLOR_NAMES = {
  '#000000': '黒', '#1f2937': '墨', '#4b5563': '濃い灰', '#9ca3af': '灰', '#ffffff': '白', '#1e3a8a': '紺', '#2563eb': '青',
  '#0ea5e9': '水色', '#0d9488': '青緑', '#16a34a': '緑', '#65a30d': '黄緑', '#ca8a04': '黄土', '#f59e0b': '山吹', '#ea580c': '橙',
  '#dc2626': '赤', '#be185d': '臙脂', '#db2777': '桃', '#9333ea': '紫', '#6d28d9': '菫', '#78350f': '茶',
  '#fde047': '黄', '#fef08a': '薄い黄', '#fdba74': '橙', '#fca5a5': '赤', '#f9a8d4': '桃', '#d8b4fe': '藤', '#a5b4fc': '青紫',
  '#93c5fd': '空色', '#67e8f9': '水色', '#86efac': '緑', '#bef264': '黄緑', '#d1d5db': '灰',
};
const colorName = (c) => COLOR_NAMES[c] || c;

function colorPopover(anchor, k, i) {
  openPopover(anchor, (body, close) => {
    body.classList.add('palette');
    const pal = k === 'marker' ? MARKER_PALETTE : PEN_PALETTE;
    const grid = document.createElement('div');
    grid.className = 'pal-grid';
    const pick = (c) => {
      S.slots[k].colors[i] = c;
      S[k].ci = i;
      S[k].color = c;
      for (const x of grid.children) x.classList.toggle('on', x.dataset.c === c);
      savePrefs();
      refreshToolbar();
    };
    for (const c of pal) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pal-c' + (c === S[k].color ? ' on' : '');
      b.dataset.c = c;
      b.style.setProperty('--c', c);
      b.title = colorName(c);
      b.setAttribute('aria-label', colorName(c));
      b.onclick = () => { pick(c); close(); };
      grid.appendChild(b);
    }
    const custom = document.createElement('label');
    custom.className = 'pal-custom';
    custom.innerHTML = `<input type="color" value="${S[k].color.length === 7 ? S[k].color : '#000000'}"><span>ほかの色…</span>`;
    custom.querySelector('input').oninput = (e) => pick(e.target.value);
    custom.querySelector('input').onchange = () => close();
    body.append(grid, custom);
  });
}

function widthPopover(anchor, k, i) {
  openPopover(anchor, (body) => {
    body.classList.add('width-pop');
    const [lo, hi, step] = WIDTH_RANGE[k];
    const color = S[k].color;
    body.innerHTML = `${narrow() ? '<div class="wp-slots"></div>' : ''}<div class="wp-preview"><svg viewBox="0 0 200 40" width="200" height="40" aria-hidden="true"><path d="M10 28 C 50 4, 90 4, 110 20 S 170 36, 190 12" fill="none" stroke="${color}" stroke-linecap="round" ${k === 'marker' ? 'opacity=".45"' : ''}/></svg></div>
      <div class="wp-row"><input type="range" min="${lo}" max="${hi}" step="${step}" aria-label="太さ"><output></output></div>`;
    const r = body.querySelector('input'), out = body.querySelector('output'), path = body.querySelector('path');
    const slots = body.querySelector('.wp-slots');
    if (slots) {
      S.slots[k].widths.forEach((w, j) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wp-slot' + (j === S[k].wi ? ' on' : '');
        b.textContent = (k === 'marker' ? w.toFixed(0) : w.toFixed(1)) + 'pt';
        b.onclick = () => {
          i = j;
          S[k].wi = j;
          S[k].width = S.slots[k].widths[j];
          r.value = S[k].width;
          for (const x of slots.children) x.classList.toggle('on', x === b);
          show();
          savePrefs();
          refreshToolbar();
          retargetPopover(anchor, (anchor = $('#widths').children[j]));
        };
        slots.appendChild(b);
      });
    }
    r.value = S[k].width;
    const show = () => {
      const w = +r.value;
      out.textContent = (k === 'marker' ? w.toFixed(0) : w.toFixed(1)) + ' pt';
      path.setAttribute('stroke-width', Math.min(30, w * 1.2));
    };
    show();
    r.oninput = () => {
      const v = Math.round(Math.round(+r.value / step) * step * 10) / 10;
      S.slots[k].widths[i] = v;
      S[k].wi = i;
      S[k].width = v;
      if (slots) slots.children[i].textContent = (k === 'marker' ? v.toFixed(0) : v.toFixed(1)) + 'pt';
      show();
      refreshToolbar();
    };
    r.onchange = () => savePrefs();
  }, { onClose: savePrefs });
}

function eraserSizePopover(anchor) {
  openPopover(anchor, (body, close) => menu(body, ['小さい', '中くらい', '大きい'].map((label, j) => ({
    label, on: undefined, attrs: { 'data-size': j }, icon: j === S.eraser.si ? 'check' : undefined,
    onClick: () => { S.eraser.si = j; savePrefs(); refreshToolbar(); },
  })), close));
}

function eraserPopover(anchor) {
  openPopover(anchor, (body, close) => menu(body, [
    { icon: 'marker', label: '蛍光ペンだけ消す', id: 'eraser-marker-only', on: S.eraser.markerOnly, onClick: () => {
      S.eraser.markerOnly = !S.eraser.markerOnly;
      savePrefs();
      refreshToolbar();
    } },
  ], close));
}

function setTool(t) {
  if (t !== 'lasso') clearSelection();
  // 選んでいる道具をもう一度押すと、その道具の設定を出す
  if (S.tool === t) {
    if (t === 'pen' || t === 'marker') colorPopover($('#tool-' + t), t, Math.max(0, S[t].ci));
    else if (t === 'eraser') eraserPopover($('#tool-eraser'));
    return;
  }
  closePopover();
  S.tool = t;
  savePrefs();
  refreshToolbar();
}

function moreMenu(anchor) {
  const zoom = document.createElement('div');
  zoom.className = 'menu-zoom';
  zoom.innerHTML = `<span class="menu-cap">表示の大きさ(数字を押すと幅に合わせる)</span>
    <div class="zoom-row"><button type="button" id="zoom-out" aria-label="縮小">${icon('zoomOut', 20)}</button><button type="button" id="zoom-label" title="幅に合わせる"></button><button type="button" id="zoom-in" aria-label="拡大">${icon('zoomIn', 20)}</button></div>`;
  const zl = zoom.querySelector('#zoom-label');
  const showZ = () => (zl.textContent = Math.round(S.zoom * 100) + '%');
  showZ();
  zoom.querySelector('#zoom-in').onclick = () => { setZoom(S.zoom * 1.25); showZ(); };
  zoom.querySelector('#zoom-out').onclick = () => { setZoom(S.zoom / 1.25); showZ(); };
  zl.onclick = () => { setZoom(fitZoom()); showZ(); };
  openPopover(anchor, (body, close) => menu(body, [
    { el: zoom },
    '-',
    { icon: 'page', label: 'ページを追加…', id: 'add-page', onClick: () => openAddDialog() },
    { icon: 'thumbs', label: 'ページへ移動…', id: 'goto-page', onClick: () => gotoPagePopover($('#page-ind')) },
    { icon: 'pdf', label: 'PDF のページを追加…', id: 'add-pdf', onClick: () => $('#pdf-add-input').click() },
    { icon: 'export', label: 'PDF に書き出す', id: 'export-pdf', onClick: exportCurrentPdf },
    '-',
    { icon: 'rename', label: '名前を変更', onClick: renameNote },
    { icon: 'finger', label: '指で書く', id: 'finger', on: S.fingerDraw, onClick: () => {
      S.fingerDraw = !S.fingerDraw;
      savePrefs();
      toast(S.fingerDraw ? '指でも書けるようにしました' : 'ペンだけで書けるようにしました(指はスクロール)');
    } },
  ], close), { align: 'end' });
}

async function exportCurrentPdf() {
  try {
    toast('PDFを作成しています…', 60000);
    const bytes = await exportPdf(S.note);
    download(new Blob([bytes], { type: 'application/pdf' }), `${safeName(S.note.title)}.pdf`);
    toast('PDFを書き出しました');
  } catch (e) {
    toast('PDFを書き出せませんでした: ' + e.message, 6000);
  }
}

async function renameNote() {
  const title = await askName('ノートの名前', S.note.title);
  if (!title || title === S.note.title) return;
  await commit([mk('note.rename', { title })]);
  $('#title').textContent = S.note.title;
  document.title = S.note.title + ' - 大学ノート';
}

function bindEditor() {
  $('#back').onclick = () => (location.hash = '#/');
  for (const t of ['pen', 'marker', 'eraser', 'lasso']) $('#tool-' + t).onclick = () => setTool(t);
  $('#shapes').onclick = () => {
    S.shapes = !S.shapes;
    savePrefs();
    refreshToolbar();
    toast(S.shapes ? '図形補正をオンにしました(書き終わりでペンを止めると図形に整えます)' : '図形補正をオフにしました');
  };
  $('#undo').onclick = undo;
  $('#redo').onclick = redo;
  $('#more-btn').onclick = (e) => moreMenu(e.currentTarget);
  $('#pages-btn').onclick = () => toggleSidebar();
  $('#pages-close').onclick = () => toggleSidebar(false);
  $('#sb-scrim').onclick = () => toggleSidebar(false);
  $('#page-ind').onclick = (e) => gotoPagePopover(e.currentTarget);
  $('#sb-add').onclick = () => openAddDialog();
  $('#pdf-add-input').onchange = addPdfPages;
  $('#title').onclick = renameNote;
  bindAddDialog();
  document.addEventListener('keydown', (e) => {
    if ($('#editor').hidden || e.repeat || e.target.closest('input, select, textarea, dialog')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod && (k === '=' || k === '+')) { e.preventDefault(); setZoom(S.zoom * 1.25); }
    else if (mod && k === '-') { e.preventDefault(); setZoom(S.zoom / 1.25); }
    else if (mod && k === '0') { e.preventDefault(); setZoom(fitZoom()); }
    else if (mod) return;
    else if (k === 'p') setTool('pen');
    else if (k === 'h') setTool('marker');
    else if (k === 'e') setTool('eraser');
    else if (k === 'l') setTool('lasso');
    else if ((k === 'delete' || k === 'backspace') && S.sel) deleteSelection();
    else if (k === 'escape') clearSelection();
  });
  bindInput();
  $('#scroller').addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => {
    if (!S.note) return;
    keepPosition(() => { if (S.fit) S.zoom = fitZoom(); layoutPages(); });
  });
}

async function openNote(id, pageId) {
  if (!S.note || S.note.id !== id) {
    closeEditor();
    const ops = await db.opsForNote(id);
    const note = emptyNote(id);
    for (const op of ops) applyOp(note, op);
    if (!note.titleS || note.deleted) { location.hash = '#/'; return; }
    S.note = note;
    S.undo = [];
    S.redo = [];
    $('#library').hidden = true;
    $('#editor').hidden = false;
    $('#title').textContent = note.title;
    document.title = note.title + ' - 大学ノート';
    setSaved(true);
    if (window.innerWidth <= 700) S.sidebar = false; // スマホではノートを開くたびに閉じた状態から
    $('#sidebar').hidden = !S.sidebar;
    $('#sb-scrim').hidden = !S.sidebar;
    S.zoom = fitZoom();
    S.fit = true;
    renderPages();
    $('#scroller').scrollTop = 0;
    refreshToolbar();
    onScroll();
  }
  if (pageId) S.views.get(pageId)?.el.scrollIntoView({ block: 'start' });
}

function closeEditor() {
  if (S.io) S.io.disconnect();
  for (const v of S.views.values()) releaseView(v);
  S.views.clear();
  S.note = null;
  S.sel = null;
  closePopover();
  const pages = $('#pages');
  if (pages) pages.innerHTML = '';
  $('#pp-list').innerHTML = '';
  S.thumbs = new Map();
}

function fitZoom() {
  const sc = $('#scroller');
  const pages = S.note ? pagesOf(S.note) : [];
  const maxW = Math.max(PAGE_A4.w, ...pages.map((p) => p.w));
  const avail = (sc.clientWidth || window.innerWidth) - 32;
  return clampZoom(Math.min(avail / maxW, 1.5));
}
const clampZoom = (z) => Math.max(0.3, Math.min(4, z));

// ---------- ページの表示 ----------
// 背景の PDF だけキャンバス(画像)で描き、罫線と手書きは SVG(ベクター)で描く。
// SVG はブラウザが拡大率に合わせて描き直すので、どれだけ拡大してもギザギザにならない。
const SVGNS = 'http://www.w3.org/2000/svg';

function renderPages() {
  const wrap = $('#pages');
  if (S.io) S.io.disconnect();
  for (const v of S.views.values()) releaseView(v);
  S.views.clear();
  S.sel = null;
  wrap.innerHTML = '';
  S.io = new IntersectionObserver(onIntersect, { root: $('#scroller'), rootMargin: '800px 0px' });
  const pages = pagesOf(S.note);
  pages.forEach((pg, i) => {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.id = pg.id;
    el.innerHTML = `<canvas class="bg"></canvas>
      <svg class="ink" xmlns="${SVGNS}" viewBox="0 0 ${pg.w} ${pg.h}" preserveAspectRatio="none"><g class="tpl"></g><g class="strokes"></g><g class="live"></g></svg>`;
    wrap.appendChild(el);
    const v = {
      pg, el, bg: el.querySelector('.bg'), tpl: el.querySelector('.tpl'), strokes: el.querySelector('.strokes'),
      live: el.querySelector('.live'), els: new Map(), visible: false, ready: false, holder: {}, bgZoom: 0,
    };
    S.views.set(pg.id, v);
    sizeView(v);
    S.io.observe(el);
  });
  // 最後のページの下に「ページを追加」
  const add = document.createElement('button');
  add.className = 'add-tile';
  add.id = 'add-tile';
  add.innerHTML = `${icon('plus', 22)}<span>ページを追加</span>`;
  add.title = '最後のページと同じ用紙で追加(長押し・右クリックで用紙を選ぶ)';
  longPress(add, () => openAddDialog('last', pagesOf(S.note).at(-1)));
  add.onclick = () => addPage('last', undefined, undefined, pagesOf(S.note).at(-1));
  wrap.appendChild(add);
  sizeAddTile();
  renderSidebar();
  onScroll();
}

function sizeAddTile() {
  const pages = pagesOf(S.note);
  const last = pages[pages.length - 1];
  const t = $('#add-tile');
  if (t && last) t.style.width = last.w * S.zoom + 'px';
}

function sizeView(v) {
  v.el.style.width = v.pg.w * S.zoom + 'px';
  v.el.style.height = v.pg.h * S.zoom + 'px';
}

let bgTimer = 0;
function layoutPages() {
  for (const v of S.views.values()) sizeView(v);
  sizeAddTile();
  // PDF の背景は拡大率が決まってから描き直す(SVG はそのままで滑らか)
  clearTimeout(bgTimer);
  bgTimer = setTimeout(() => { for (const v of S.views.values()) if (v.visible && v.bgZoom !== S.zoom) paintBg(v); }, 250);
  drawSelection();
  refreshToolbar();
}

function setZoom(z, focus) {
  z = clampZoom(z);
  const sc = $('#scroller');
  const fx = focus ? focus.x : sc.clientWidth / 2;
  const fy = focus ? focus.y : sc.clientHeight / 2;
  const cx = (sc.scrollLeft + fx) / S.zoom, cy = (sc.scrollTop + fy) / S.zoom;
  S.zoom = z;
  S.fit = Math.abs(z - fitZoom()) < 0.005;
  layoutPages();
  sc.scrollLeft = cx * z - fx;
  sc.scrollTop = cy * z - fy;
}

// 表示を作り直しても、今見ているページの同じ場所(ページの何割目か)に戻す
function keepPosition(fn) {
  const sc = $('#scroller');
  const pg = currentPage();
  let frac = 0, fx = 0;
  const v = pg && S.views.get(pg.id);
  if (v) {
    const r = v.el.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    frac = (sr.top - r.top) / r.height;
    fx = sc.scrollWidth > sc.clientWidth ? sc.scrollLeft / (sc.scrollWidth - sc.clientWidth) : 0;
  }
  fn();
  const nv = pg && S.views.get(pg.id);
  if (!nv) return;
  const r = nv.el.getBoundingClientRect(), sr = sc.getBoundingClientRect();
  sc.scrollTop += r.top - sr.top + frac * r.height;
  sc.scrollLeft = fx * Math.max(0, sc.scrollWidth - sc.clientWidth);
}

function onIntersect(entries) {
  for (const en of entries) {
    const v = S.views.get(en.target.dataset.id);
    if (!v) continue;
    if (en.isIntersecting && !v.visible) { v.visible = true; paintView(v); }
    else if (!en.isIntersecting && v.visible) { v.visible = false; releaseView(v); }
  }
}

function releaseView(v) {
  v.holder.task?.cancel?.();
  v.bg.width = v.bg.height = 0; // メモリを返す
  v.tpl.innerHTML = v.strokes.innerHTML = v.live.innerHTML = '';
  v.els.clear();
  v.ready = false;
  v.bgZoom = 0;
}

function canvasSize(v) {
  const dpr = window.devicePixelRatio || 1;
  let cw = v.pg.w * S.zoom * dpr, ch = v.pg.h * S.zoom * dpr;
  const k = Math.min(1, Math.sqrt(MAX_CANVAS_PX / (cw * ch)));
  return [Math.round(cw * k), Math.round(ch * k)];
}

function paintView(v) {
  v.ready = true;
  paintBg(v);
  paintInk(v);
}

function paintBg(v) {
  const bg = bgOf(v.pg);
  v.holder.task?.cancel?.();
  v.bgZoom = S.zoom;
  if (bg && bg.type === 'pdf') {
    v.tpl.innerHTML = '';
    const c = v.bg;
    [c.width, c.height] = canvasSize(v);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    renderPdfPage(c, bg.hash, bg.page, v.holder).catch((e) => {
      ctx.fillStyle = '#999';
      ctx.font = `${14 * c.width / v.pg.w}px sans-serif`;
      ctx.fillText(e.message, 20, 40);
    });
  } else {
    v.bg.width = v.bg.height = 0;
    v.tpl.innerHTML = templateSvg(bg, v.pg.w, v.pg.h);
  }
}

function templateSvg(bg, w, h, minW = 0) {
  const prim = templatePrims(bg, w, h);
  const groups = new Map();
  for (const [x0, y0, x1, y1, t, c] of prim.lines) {
    const k = `${t}|${c}`;
    groups.set(k, (groups.get(k) || '') + `M${x0.toFixed(2)} ${y0.toFixed(2)}L${x1.toFixed(2)} ${y1.toFixed(2)}`);
  }
  let out = '';
  for (const [k, d] of groups) {
    const [t, c] = k.split('|');
    out += `<path d="${d}" stroke="${c}" stroke-width="${Math.max(+t, minW)}" fill="none"/>`;
  }
  if (prim.dots.length) {
    const [, , r, c] = prim.dots[0];
    out += `<path d="${prim.dots.map(([x, y]) => `M${x.toFixed(2)} ${y.toFixed(2)}h0`).join('')}" stroke="${c}" stroke-width="${Math.max(r * 2, minW * 1.6)}" stroke-linecap="round" fill="none"/>`;
  }
  return out;
}

// サムネイル用(キャンバス)
function paintTemplate(ctx, bg, w, h, minW = 0) {
  const prim = templatePrims(bg, w, h);
  for (const [x0, y0, x1, y1, t, c] of prim.lines) {
    ctx.strokeStyle = c;
    ctx.lineWidth = Math.max(t, minW);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  for (const [x, y, r, c] of prim.dots) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function scaledCtx(canvas, pg) {
  const ctx = canvas.getContext('2d');
  const s = canvas.width / pg.w;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  return ctx;
}

// 線の形は一度作ったら覚えておく(線の中身は変わらないので)
function geoOf(e) {
  if (!e.geo) e.geo = geometry(e.data);
  return e.geo;
}

// hidden: 消しゴムで消している最中の線 / moving: { ids:Set, dx, dy } 投げ縄で動かしている最中の線
function paintInk(v, hidden, moving) {
  if (!v.ready) return;
  if ((hidden || moving) && v.els.size) {
    // 描き直さず、該当する線だけ隠す・ずらす
    if (hidden) for (const id of hidden) { const el = v.els.get(id); if (el) el.style.display = 'none'; }
    if (moving) {
      for (const id of moving.ids) {
        const el = v.els.get(id), st = S.note.strokes.get(id);
        if (el && st) el.setAttribute('transform', `translate(${st.off[0] + moving.dx} ${st.off[1] + moving.dy})`);
      }
    }
    return;
  }
  v.strokes.innerHTML = strokesOf(S.note, v.pg.id).map((e) => strokeSvg(e.id, styleOf(e), geoOf(e), e.off)).join('');
  v.els.clear();
  for (const el of v.strokes.children) v.els.set(el.dataset.id, el);
}

// 確定した線を1本だけ足す
function appendStroke(v, id) {
  const e = S.note.strokes.get(id);
  if (!v.ready || !e) return;
  v.strokes.insertAdjacentHTML('beforeend', strokeSvg(e.id, styleOf(e), geoOf(e), e.off));
  v.els.set(id, v.strokes.lastElementChild);
}

// 書いている最中の線(毎フレーム描き直す)
function paintLive(v, svg) {
  v.live.innerHTML = svg || '';
}

// ---------- 入力(ペン・マウス・指) ----------
let active = null; // 書いている最中の線 / 消している最中 / 投げ縄
const touches = new Map();
let pinch = null, inertia = null, lastPenTime = 0, liveFrame = 0;
// ペンを離した直後の線。iPad では手のひらが触れたときなどに、書いている途中で
// ペンの入力がいったん途切れる(pointercancel / pointerup)ことがある。すぐに同じ場所から
// 続きが来たら同じ線としてつなぐため、確定を少し待つ。
let penPending = null;
// つなぐのは pointercancel(システムが止めた)のときだけ。pointerup は本当にペンを離したとみなす
// (実機では、小さな文字を書くときの離してから次を書くまでが 70〜110ms ほどで、待つと別の線がつながってしまった)
const PEN_JOIN = { cancel: { ms: 400, px: 64 } };
const palmRecent = () => !!active || !!penPending || Date.now() - lastPenTime < 600;

function bindInput() {
  const sc = $('#scroller');
  // iPad Safari: Apple Pencil でスクロールしないようにする
  sc.addEventListener('touchstart', (e) => {
    if ([...e.touches].some((t) => t.touchType === 'stylus') || palmRecent()) e.preventDefault();
  }, { passive: false });
  sc.addEventListener('touchmove', (e) => { if (active || touches.size) e.preventDefault(); }, { passive: false });
  if (/[?&]debug/.test(location.search)) {
    for (const t of ['pointerdown', 'pointerup', 'pointercancel']) sc.addEventListener(t, (e) => debugCount(`${t.slice(7)}:${e.pointerType}`), true);
  }
  bindFingerTaps(sc);
  sc.addEventListener('pointerdown', onDown);
  sc.addEventListener('pointermove', onMove);
  sc.addEventListener('pointerup', onUp);
  sc.addEventListener('pointercancel', onUp);
  sc.addEventListener('wheel', (e) => {
    if (e.ctrlKey) { // トラックパッドのピンチ
      e.preventDefault();
      const r = sc.getBoundingClientRect();
      setZoom(S.zoom * Math.exp(-e.deltaY / 100), { x: e.clientX - r.left, y: e.clientY - r.top });
    }
  }, { passive: false });
}

// ?debug を付けて開くと、入力イベントの回数を画面の隅に表示する(不具合の調査用)
const debugCounts = {};
function debugCount(k) {
  if (!/[?&]debug/.test(location.search)) return;
  if (k) debugCounts[k] = (debugCounts[k] || 0) + 1;
  let el = document.getElementById('debug-box');
  if (!el) {
    el = document.createElement('pre');
    el.id = 'debug-box';
    el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99;margin:0;padding:6px 8px;font:12px monospace;background:rgba(255,255,255,.9);border:1px solid #ccc;border-radius:6px;pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent = 'v13\n' + Object.entries(debugCounts).map(([a, b]) => `${a} ${b}`).join('\n') + '\n' + debugGaps.join('\n');
}
// 書いている線の入力の中身(1回の move にまとめられた点の数、座標が整数か、筆圧)
const debugOn = /[?&]debug/.test(location.search);
const dbgIn = { frames: 0, co: 0, coInt: 0, mainInt: 0, p0: 0, pr: new Set(), skipped: 0, at: [0, 0, 0], old: 0, zig: 0, dup: 0 };
function debugInput(e, evs) {
  const isInt = (ev) => Number.isInteger(ev.clientX) && Number.isInteger(ev.clientY);
  dbgIn.frames++;
  dbgIn.co += evs.length;
  dbgIn.coInt += evs.filter(isInt).length;
  if (isInt(e)) dbgIn.mainInt++;
  evs.forEach((ev, i) => { if (isInt(ev)) dbgIn.at[i === 0 ? 0 : i === evs.length - 1 ? 2 : 1]++; });
  for (const ev of evs) { if (!(ev.pressure > 0)) dbgIn.p0++; dbgIn.pr.add(Math.round(ev.pressure * 1000)); }
  const last = evs[evs.length - 1];
  debugCounts['move'] = `${dbgIn.frames} 点/回 ${(dbgIn.co / dbgIn.frames).toFixed(1)} 整数 ${dbgIn.coInt}/${dbgIn.co} 本体整数 ${dbgIn.mainInt} 筆圧0 ${dbgIn.p0} 筆圧の種類 ${dbgIn.pr.size} 最後とずれ ${last ? Math.hypot(last.clientX - e.clientX, last.clientY - e.clientY).toFixed(2) : '-'}\n整数の位置(先頭/途中/最後) ${dbgIn.at.join('/')} 使わなかった点 ${dbgIn.skipped}\n古い点 ${dbgIn.old} 同じ位置 ${dbgIn.dup} 折り返し ${dbgIn.zig}`;
  if (dbgIn.frames % 10 === 0) debugCount(null);
}

// 点が行ったり来たりしていないか(短い間隔で向きが 120° 以上変わる)を数える
function debugZig(a, ev) {
  const q = [ev.clientX, ev.clientY], h = (a.dbgHist ||= []);
  if (h.length && h[h.length - 1][0] === q[0] && h[h.length - 1][1] === q[1]) { dbgIn.dup++; return; }
  if (h.length >= 2) {
    const [p0, p1] = h.slice(-2);
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], vx = q[0] - p1[0], vy = q[1] - p1[1];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu && lv && (ux * vx + uy * vy) / (lu * lv) < -0.5) dbgIn.zig++;
  }
  h.push(q);
  if (h.length > 3) h.shift();
}

// ペンが途切れて再開したときの間隔(時間・距離・つないだか)
const debugGaps = [];
function debugGap(how, dt, dist, ok) {
  debugGaps.unshift(`${how} ${Math.round(dt)}ms ${Math.round(dist)}px ${ok ? 'つないだ' : '別の線'}`);
  debugGaps.length = Math.min(debugGaps.length, 8);
  debugCount(ok ? 'joined' : 'notjoined');
}

// 2本指で軽くたたくと元に戻す、3本指でやり直す。
// 書いた直後(手のひらとして指を無視している間)や「指で書く」のときも効くように、他の処理とは別に見張る
function bindFingerTaps(sc) {
  const pts = new Map();
  let tap = null;
  sc.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (active && active.pen) { tap = null; return; } // ペンで書いている最中の指は手のひら
    if (!pts.size) tap = { t: performance.now(), n: 0, bad: false };
    pts.set(e.pointerId, { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY });
    if (!tap) return;
    tap.n = Math.max(tap.n, pts.size);
    if (e.width > 45 || e.height > 45) tap.bad = true; // 接する面が大きいのは手のひら
  }, true);
  sc.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (tap && Math.hypot(p.x - p.x0, p.y - p.y0) > 12) tap.bad = true;
  }, true);
  const up = (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    // 最初の指が離れた時点で決める
    if (tap && tap.n >= 2) {
      const t = tap;
      tap = null;
      const list = [...pts.values()];
      const spread = Math.max(...list.map((a) => Math.max(...list.map((b) => Math.hypot(a.x - b.x, a.y - b.y)))));
      if (e.type === 'pointerup' && !t.bad && performance.now() - t.t < 350 && spread < 260) {
        // 「指で書く」で1本目の指が書き始めていた線は捨てる
        if (active && active.kind === 'draw' && !active.pen) { cancelAnimationFrame(liveFrame); paintLive(active.v, ''); active = null; }
        touches.clear();
        pinch = null;
        $('#pages').style.transform = '';
        stopInertia();
        if (t.n === 2) undo(); else redo();
      }
    }
    pts.delete(e.pointerId);
    if (!pts.size) tap = null;
  };
  sc.addEventListener('pointerup', up, true);
  sc.addEventListener('pointercancel', up, true);
}

function pagePoint(v, e) {
  const r = v.el.getBoundingClientRect();
  return [(e.clientX - r.left) / S.zoom, (e.clientY - r.top) / S.zoom];
}

function onDown(e) {
  if (!S.note) return;
  if (e.target.closest('.sel-bar')) return;
  const isTouch = e.pointerType === 'touch';
  // ペンで書いている最中・直後の指は手のひらとみなして無視する
  if (isTouch && palmRecent()) return;
  if (isTouch && !S.fingerDraw) return gestureDown(e);
  if (e.pointerType === 'pen') {
    // 手のひらを先に置いていた場合: 指の操作(スクロール・ズーム)を止める
    if (touches.size) { touches.clear(); pinch = null; $('#pages').style.transform = ''; }
    // 途切れた線の続きならつなぐ
    // 前のペンの入力が終わらないまま、新しいペンの入力が始まった: 同じペンなので引き継ぐ
    if (active && active.kind === 'draw' && active.pen && active.id !== e.pointerId) {
      e.preventDefault();
      debugGap('重なり', 0, 0, true);
      active.id = e.pointerId;
      addPoint(e);
      return;
    }
    if (!active && penPending && S.tool !== 'lasso' && S.tool !== 'eraser' && !(e.buttons & 32) && e.button !== 5) {
      const pp = penPending;
      const dt = performance.now() - pp.t, dist = Math.hypot(e.clientX - pp.x, e.clientY - pp.y);
      // 速く書いているときは、途切れている間にペンが進んだ分も許す
      const lim = PEN_JOIN[pp.how];
      const ok = dt < lim.ms && dist < lim.px + (pp.a.speed || 0) * dt * 1.5;
      debugGap(pp.how, dt, dist, ok);
      if (ok) {
        clearTimeout(pp.timer);
        penPending = null;
        e.preventDefault();
        lastPenTime = Date.now();
        try { $('#scroller').setPointerCapture(e.pointerId); } catch {}
        active = pp.a;
        active.id = e.pointerId;
        addPoint(e);
        return;
      }
    }
  }
  flushPen();
  if (active) return;
  if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 5) return;
  const pageEl = e.target.closest?.('.page');
  if (!pageEl || e.target.closest('.page-foot')) return;
  const v = S.views.get(pageEl.dataset.id);
  if (!v || !v.ready) return;
  e.preventDefault();
  stopInertia();
  try { $('#scroller').setPointerCapture(e.pointerId); } catch {}
  if (e.pointerType === 'pen') lastPenTime = Date.now();
  const [x, y] = pagePoint(v, e);
  const eraser = S.tool === 'eraser' || (e.buttons & 32) || e.button === 5;
  if (eraser) {
    active = { id: e.pointerId, v, kind: 'erase', hits: new Set() };
    eraseAt(e);
  } else if (S.tool === 'lasso') {
    const b = S.sel && S.sel.pageId === v.pg.id && S.sel.box;
    if (b && x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) {
      active = { id: e.pointerId, v, kind: 'move', sx: x, sy: y, dx: 0, dy: 0 };
    } else {
      clearSelection();
      active = { id: e.pointerId, v, kind: 'lasso', poly: [[x, y]] };
    }
  } else {
    const st = toolState();
    const d = { id: newId(), pageId: v.pg.id, tool: S.tool, color: st.color, width: st.width, pr: e.pointerType === 'pen' && S.tool === 'pen', pts: [] };
    // ならす強さ: 画面上で約 2.5px 分。拡大して書くほど小さくして、小さな字の形を崩さない
    d.sm = Math.round(Math.max(0.3, Math.min(1.5, 2.5 / S.zoom)) * 100) / 100;
    active = { id: e.pointerId, v, kind: 'draw', pen: e.pointerType === 'pen', d, lastMove: performance.now() };
    addPoint(e);
  }
}

function onMove(e) {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    if (palmRecent()) return; // 手のひらが動いてもスクロールしない
    return gestureMove(e);
  }
  if (!active || e.pointerId !== active.id) return;
  if (e.pointerType === 'pen') lastPenTime = Date.now();
  if (active.kind === 'draw') {
    // 画面上の速さ(px/ms)を覚えておく(途切れた線をつなぐ判定に使う)
    const now = performance.now(), l = active.lastXY;
    if (l && now > active.lastT) {
      const sp = Math.hypot(e.clientX - l[0], e.clientY - l[1]) / (now - active.lastT);
      active.speed = 0.7 * (active.speed || 0) + 0.3 * Math.min(sp, 5);
    }
    active.lastXY = [e.clientX, e.clientY];
    active.lastT = now;
  }
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  const a = active;
  if (debugOn && a.kind === 'draw') debugInput(e, evs);
  for (const ev of evs.length ? evs : [e]) {
    if (a.kind === 'erase') eraseAt(ev);
    else if (a.kind === 'draw') {
      // iPad Safari では、まとめて届く点のうち一部だけ座標が整数に丸められている。
      // 丸められた点は本当の位置から最大 0.5px ずれ、線に周期的なカクつきができるので、
      // ペンで小数の座標が来ている線では、整数の点を使わない
      const int = Number.isInteger(ev.clientX) && Number.isInteger(ev.clientY);
      // 前に使った点より古い点(同じ点が2回届いたもの)は使わない。使うと線が行ったり来たりして太って見える
      if (ev.timeStamp && a.lastTs && ev.timeStamp < a.lastTs) { if (debugOn) dbgIn.old++; continue; }
      if (!int) a.frac = true;
      else if (a.pen && (a.frac || evs.some((x) => !Number.isInteger(x.clientX)))) { if (debugOn) dbgIn.skipped++; continue; }
      if (debugOn) debugZig(a, ev);
      if (ev.timeStamp) a.lastTs = ev.timeStamp;
      addPoint(ev);
    }
    else if (a.kind === 'lasso') {
      const p = pagePoint(a.v, ev);
      const l = a.poly[a.poly.length - 1];
      if (Math.hypot(p[0] - l[0], p[1] - l[1]) > 2 / S.zoom) a.poly.push(p);
    } else if (a.kind === 'move') {
      const [x, y] = pagePoint(a.v, ev);
      a.dx = x - a.sx;
      a.dy = y - a.sy;
    }
  }
  if (a.kind === 'lasso') requestLive(() => paintLive(a.v, lassoSvg(a.poly)));
  if (a.kind === 'move') requestLive(() => { paintInk(a.v, null, { ids: S.sel.ids, dx: a.dx, dy: a.dy }); drawSelection(a.dx, a.dy); });
}

function requestLive(fn) {
  cancelAnimationFrame(liveFrame);
  liveFrame = requestAnimationFrame(fn);
}

function lassoSvg(poly) {
  const d = poly.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join('') + 'Z';
  return `<path d="${d}" fill="rgba(47,93,158,.06)" stroke="#2f5d9e" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>`;
}

function addPoint(e) {
  const a = active, d = a.d;
  if (a.shaped) return;
  const [x, y] = pagePoint(a.v, e);
  const n0 = d.pts.length / 3;
  if (n0) {
    const lx = d.pts[d.pts.length - 3], ly = d.pts[d.pts.length - 2];
    if (Math.hypot(x - lx, y - ly) < 0.5 / S.zoom) return; // 近すぎる点は捨てる
  }
  // Safari は途中の点で筆圧 0 を返すことがあるので、そのときは直前の筆圧を使う
  let p = 0.5;
  if (d.pr) {
    p = e.pressure > 0 ? e.pressure : (n0 ? d.pts[d.pts.length - 1] : 0.5);
  }
  d.pts.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(p * 100) / 100);
  // 図形補正: ペンを止めたら図形に整える
  if (S.shapes && S.tool === 'pen') {
    clearTimeout(a.holdTimer);
    a.holdTimer = setTimeout(() => {
      if (active !== a || a.shaped) return;
      const shape = recognizeShape(d.pts);
      if (!shape) return;
      d.pts = shape.pts;
      d.shape = shape.type;
      a.shaped = true;
      paintLive(a.v, strokeSvg('live', d, geometry(d)));
    }, 550);
  }
  requestLive(() => paintLive(a.v, strokeSvg('live', d, geometry(d))));
}

function eraseAt(e) {
  const a = active;
  const [x, y] = pagePoint(a.v, e);
  const r = ERASER_SIZES[S.eraser.si ?? 1] / S.zoom;
  let changed = false;
  for (const st of strokesOf(S.note, a.v.pg.id, a.hits)) {
    if (S.eraser.markerOnly && st.data.tool !== 'marker') continue;
    if (strokeHit(st, x, y, r)) { a.hits.add(st.id); changed = true; }
  }
  if (changed) paintInk(a.v, a.hits);
}

async function onUp(e) {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) return gestureUp(e);
  if (!active || e.pointerId !== active.id) return;
  const a = active;
  active = null;
  cancelAnimationFrame(liveFrame);
  if (a.kind === 'erase') {
    if (!a.hits.size) return;
    const ids = [...a.hits];
    pushUndo({ undo: [['stroke.undel', { ids }]], redo: [['stroke.del', { ids }]], pages: [a.v.pg.id] });
    await commit([mk('stroke.del', { ids })]);
    paintInk(a.v);
    return;
  }
  if (a.kind === 'lasso') {
    paintLive(a.v, '');
    if (a.poly.length < 3) return;
    const ids = new Set(strokesOf(S.note, a.v.pg.id).filter((st) => strokeInLasso(st, a.poly)).map((st) => st.id));
    if (ids.size) {
      S.sel = { pageId: a.v.pg.id, ids };
      refreshToolbar();
      drawSelection();
    }
    return;
  }
  if (a.kind === 'move') {
    if (Math.abs(a.dx) < 0.5 && Math.abs(a.dy) < 0.5) return;
    const before = {}, after = {};
    for (const id of S.sel.ids) {
      const st = S.note.strokes.get(id);
      before[id] = st.off;
      after[id] = [Math.round((st.off[0] + a.dx) * 10) / 10, Math.round((st.off[1] + a.dy) * 10) / 10];
    }
    pushUndo({ undo: [['stroke.tf', { tf: before }]], redo: [['stroke.tf', { tf: after }]], pages: [a.v.pg.id] });
    await commit([mk('stroke.tf', { tf: after })]);
    paintInk(a.v);
    drawSelection();
    return;
  }
  clearTimeout(a.holdTimer);
  if (e.pointerType === 'pen' && e.type === 'pointercancel' && !a.shaped && a.d.pts.length) {
    const [x, y] = a.lastXY || [e.clientX, e.clientY];
    const how = 'cancel';
    penPending = { a, x, y, how, t: performance.now(), timer: setTimeout(flushPen, PEN_JOIN[how].ms) };
    paintLive(a.v, strokeSvg('live', a.d, geometry(a.d)));
    lastPenTime = Date.now();
    return;
  }
  return finishStroke(a);
}

// 確定を待っている線があれば確定する
function flushPen() {
  if (!penPending) return;
  const { a, timer } = penPending;
  clearTimeout(timer);
  penPending = null;
  finishStroke(a);
}

async function finishStroke(a) {
  const d = a.d;
  if (!d.pts.length) return paintLive(a.v, '');
  pushUndo({ undo: [['stroke.del', { ids: [d.id] }]], redo: [['stroke.undel', { ids: [d.id] }]], pages: [a.v.pg.id] });
  // commit は最初に op をノートに反映するので、その直後に確定した線を足し、書いている最中の線を消す
  const saving = commit([mk('stroke.add', { s: d })]);
  appendStroke(a.v, d.id);
  paintLive(a.v, '');
  await saving;
}

// ---------- 投げ縄の選択 ----------
function selectionBox() {
  if (!S.sel) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of S.sel.ids) {
    const st = S.note.strokes.get(id);
    if (!st || !st.alive) continue;
    const b = st.bbox;
    x0 = Math.min(x0, b.x0 + st.off[0]); y0 = Math.min(y0, b.y0 + st.off[1]);
    x1 = Math.max(x1, b.x1 + st.off[0]); y1 = Math.max(y1, b.y1 + st.off[1]);
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

function drawSelection(dx = 0, dy = 0) {
  document.querySelectorAll('.sel-box').forEach((el) => el.remove());
  if (!S.sel) return;
  const v = S.views.get(S.sel.pageId);
  const b = selectionBox();
  if (!v || !b) { S.sel = null; return; }
  S.sel.box = b;
  const el = document.createElement('div');
  el.className = 'sel-box';
  const z = S.zoom;
  Object.assign(el.style, { left: (b.x0 + dx) * z + 'px', top: (b.y0 + dy) * z + 'px', width: (b.x1 - b.x0) * z + 'px', height: (b.y1 - b.y0) * z + 'px' });
  el.innerHTML = `<div class="sel-bar"><span>${S.sel.ids.size}本を選択中</span><button data-a="del">削除</button><button data-a="dup">複製</button><button data-a="off">選択解除</button></div>`;
  el.querySelector('[data-a=del]').onclick = deleteSelection;
  el.querySelector('[data-a=dup]').onclick = duplicateSelection;
  el.querySelector('[data-a=off]').onclick = clearSelection;
  v.el.appendChild(el);
}

function clearSelection() {
  const had = !!S.sel;
  S.sel = null;
  document.querySelectorAll('.sel-box').forEach((el) => el.remove());
  if (had) refreshToolbar();
}

async function deleteSelection() {
  if (!S.sel) return;
  const ids = [...S.sel.ids], pid = S.sel.pageId;
  pushUndo({ undo: [['stroke.undel', { ids }]], redo: [['stroke.del', { ids }]], pages: [pid] });
  await commit([mk('stroke.del', { ids })]);
  clearSelection();
  const v = S.views.get(pid);
  if (v) paintInk(v);
}

async function duplicateSelection() {
  if (!S.sel) return;
  const pid = S.sel.pageId;
  const ops = [], ids = new Set();
  for (const id of S.sel.ids) {
    const st = S.note.strokes.get(id);
    const d = styleOf(st);
    const nd = { ...d, id: newId(), pts: d.pts.map((v, i) => (i % 3 === 0 ? v + st.off[0] + 12 : i % 3 === 1 ? v + st.off[1] + 12 : v)) };
    ops.push(mk('stroke.add', { s: nd }));
    ids.add(nd.id);
  }
  pushUndo({ undo: [['stroke.del', { ids: [...ids] }]], redo: [['stroke.undel', { ids: [...ids] }]], pages: [pid] });
  await commit(ops);
  S.sel = { pageId: pid, ids };
  refreshToolbar();
  const v = S.views.get(pid);
  if (v) paintInk(v);
  drawSelection();
}

async function recolorSelection(color) {
  const before = {}, after = {};
  for (const id of S.sel.ids) {
    const st = S.note.strokes.get(id);
    before[id] = { color: styleOf(st).color };
    after[id] = { color };
  }
  const pid = S.sel.pageId;
  pushUndo({ undo: [['stroke.style', { styles: before }]], redo: [['stroke.style', { styles: after }]], pages: [pid] });
  await commit([mk('stroke.style', { styles: after })]);
  const v = S.views.get(pid);
  if (v) paintInk(v);
}

// 指: 1本でスクロール(慣性つき)、2本でズーム
function gestureDown(e) {
  const sc = $('#scroller');
  try { sc.setPointerCapture(e.pointerId); } catch {}
  stopInertia();
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), vx: 0, vy: 0 });
  if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    const r = sc.getBoundingClientRect();
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), scale: 1, fx: (a.x + b.x) / 2 - r.left, fy: (a.y + b.y) / 2 - r.top };
    const pages = $('#pages');
    pages.style.transformOrigin = `${sc.scrollLeft + pinch.fx - pages.offsetLeft}px ${sc.scrollTop + pinch.fy - pages.offsetTop}px`;
  }
}
function gestureMove(e) {
  const t = touches.get(e.pointerId);
  const sc = $('#scroller');
  const now = performance.now();
  const dx = e.clientX - t.x, dy = e.clientY - t.y;
  const dt = Math.max(1, now - t.t);
  t.vx = 0.8 * (dx / dt) + 0.2 * t.vx;
  t.vy = 0.8 * (dy / dt) + 0.2 * t.vy;
  t.x = e.clientX; t.y = e.clientY; t.t = now;
  if (pinch && touches.size >= 2) {
    const [a, b] = [...touches.values()];
    pinch.scale = Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0;
    const s = clampZoom(S.zoom * pinch.scale) / S.zoom;
    $('#pages').style.transform = `scale(${s})`;
  } else if (!pinch) {
    sc.scrollLeft -= dx;
    sc.scrollTop -= dy;
  }
}
function gestureUp(e) {
  const t = touches.get(e.pointerId);
  touches.delete(e.pointerId);
  if (pinch) {
    if (touches.size < 2) {
      const p = pinch;
      pinch = null;
      $('#pages').style.transform = '';
      setZoom(S.zoom * p.scale, { x: p.fx, y: p.fy });
      touches.clear();
    }
    return;
  }
  if (touches.size === 0 && t && performance.now() - t.t < 80) startInertia(t.vx, t.vy);
}
function startInertia(vx, vy) {
  const sc = $('#scroller');
  let last = performance.now();
  const step = (now) => {
    const dt = now - last;
    last = now;
    sc.scrollLeft -= vx * dt;
    sc.scrollTop -= vy * dt;
    const f = Math.pow(0.995, dt);
    vx *= f; vy *= f;
    if (Math.hypot(vx, vy) > 0.02) inertia = requestAnimationFrame(step);
    else inertia = null;
  };
  inertia = requestAnimationFrame(step);
}
function stopInertia() {
  if (inertia) cancelAnimationFrame(inertia);
  inertia = null;
}

// ---------- 元に戻す ----------
function pushUndo(entry) {
  S.undo.push(entry);
  if (S.undo.length > 200) S.undo.shift();
  S.redo = [];
  refreshToolbar();
}
async function runEntry(list, entry) {
  await commit(list.map(([t, p]) => mk(t, p)));
  if (entry.relayout) keepPosition(() => renderPages());
  else if (entry.bg) for (const id of entry.pages || []) repaintPage(id);
  else for (const id of entry.pages || []) { const v = S.views.get(id); if (v) paintInk(v); }
  if (S.sel) drawSelection();
  refreshToolbar();
}
async function undo() {
  flushPen();
  const e = S.undo.pop();
  if (!e) return;
  S.redo.push(e);
  await runEntry(e.undo, e);
}
async function redo() {
  flushPen();
  const e = S.redo.pop();
  if (!e) return;
  S.undo.push(e);
  await runEntry(e.redo, e);
}

// ---------- ページ ----------
function currentPage() {
  const sc = $('#scroller');
  const mid = sc.getBoundingClientRect().top + sc.clientHeight / 2;
  let best = null, bestD = Infinity;
  for (const v of S.views.values()) {
    const r = v.el.getBoundingClientRect();
    const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
    if (d < bestD) { bestD = d; best = v.pg; }
  }
  return best;
}

// where: after(今のページの後ろ)| before(前)| last(最後)。tpl/size を省くと今のページと同じにする
async function addPage(where = 'after', tpl, sizeId, ref = currentPage()) {
  const pages = pagesOf(S.note);
  ref = ref || pages[pages.length - 1];
  const i = pages.indexOf(ref);
  let order;
  if (where === 'before') order = await freeOrder(pages[i - 1], ref);
  else if (where === 'last' || i === pages.length - 1) order = pages.length ? pages[pages.length - 1].order + 1 : 1;
  else order = await freeOrder(ref, pages[i + 1]);
  const cbg = ref && bgOf(ref);
  const ruling = tpl || (cbg && cbg.type === 'blank' ? cbg.ruling : 'lines-b');
  let w = PAGE_A4.w, h = PAGE_A4.h;
  if (sizeId) ({ w, h } = sizeById(sizeId));
  else if (ref) ({ w, h } = ref); // PDF のページの後ろでも同じ大きさにする
  const id = newId();
  await commit([mk('page.add', { page: { id, w, h, order, bg: { type: 'blank', ruling } } })]);
  pushUndo({ undo: [['page.delete', { pageId: id }]], redo: [['page.restore', { pageId: id }]], relayout: true });
  const top = $('#scroller').scrollTop;
  renderPages();
  $('#scroller').scrollTop = top;
  S.views.get(id)?.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return id;
}

async function deletePage(id) {
  if (pagesOf(S.note).length <= 1) return toast('最後の1ページは削除できません');
  const no = pagesOf(S.note).findIndex((p) => p.id === id) + 1;
  await commit([mk('page.delete', { pageId: id })]);
  const entry = { undo: [['page.restore', { pageId: id }]], redo: [['page.delete', { pageId: id }]], relayout: true };
  pushUndo(entry);
  keepPosition(() => renderPages());
  toast(`${no}ページ目を削除しました`, 6000, { label: '元に戻す', run: async () => {
    if (S.undo[S.undo.length - 1] !== entry) return;
    await undo();
    S.views.get(id)?.el.scrollIntoView({ block: 'start' });
  } });
}

// ---------- ページを追加(テンプレートを絵で選ぶ) ----------
let addRef = null;
function openAddDialog(where = 'after', ref = currentPage()) {
  closePopover();
  addRef = ref;
  for (const r of document.querySelectorAll('input[name=pp-where]')) r.checked = r.value === where;
  // 基準のページが今見ているページと違うときは、何ページ目かを書く
  const cur = currentPage();
  const no = ref ? pagesOf(S.note).indexOf(ref) + 1 : 0;
  const lbl = ref && cur && ref.id !== cur.id ? `${no}ページ目` : '今のページ';
  $('#pp-after-label').textContent = lbl + 'の後ろ';
  $('#pp-before-label').textContent = lbl + 'の前';
  $('#pp-size').options[0].textContent = lbl + 'と同じ';
  const bg = ref && bgOf(ref);
  $('#pp-size').value = '';
  tplPicker($('#pp-tpl'), bg?.type === 'blank' ? (bg.ruling === 'lines' ? 'lines-b' : bg.ruling) : 'lines-b', ref || PAGE_A4);
  showDialog($('#add-dialog'));
}
function bindAddDialog() {
  $('#pp-cancel').onclick = () => $('#add-dialog').close();
  $('#pp-pdf').onclick = () => { $('#add-dialog').close(); $('#pdf-add-input').click(); };
  $('#add-form').onsubmit = async (e) => {
    e.preventDefault();
    const where = document.querySelector('input[name=pp-where]:checked')?.value || 'after';
    $('#add-dialog').close();
    await addPage(where, $('#pp-tpl').dataset.value, $('#pp-size').value || undefined, addRef || undefined);
  };
}

// ---------- 今のページの表示(右下の「3 / 10」) ----------
let scrollFrame = 0, indTimer = 0, curPageId = null;
function onScroll() {
  if (scrollFrame || !S.note) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (!S.note) return;
    const pages = pagesOf(S.note);
    const pg = currentPage();
    const n = pg ? pages.indexOf(pg) + 1 : 1;
    const ind = $('#page-ind');
    ind.textContent = `${n} / ${pages.length}`;
    ind.classList.add('show');
    clearTimeout(indTimer);
    indTimer = setTimeout(() => ind.classList.remove('show'), 1400);
    if (pg && pg.id !== curPageId) {
      curPageId = pg.id;
      for (const [id, t] of S.thumbs || []) t.classList.toggle('current', id === pg.id);
      if (S.sidebar) thumbIntoView(pg.id);
    }
  });
}

async function addPdfPages(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    toast('PDFを読み込んでいます…', 60000);
    const { hash, sizes } = await importPdf(file);
    const pages = pagesOf(S.note);
    let order = pages.length ? pages[pages.length - 1].order : 0;
    const ops = sizes.map((sz, i) => mk('page.add', { page: { id: newId(), w: sz.w, h: sz.h, order: ++order, bg: { type: 'pdf', hash, page: i + 1 } } }));
    await commit(ops);
    pushUndo({ undo: ops.map((o) => ['page.delete', { pageId: o.p.page.id }]), redo: ops.map((o) => ['page.restore', { pageId: o.p.page.id }]), relayout: true });
    renderPages();
    S.views.get(ops[0].p.page.id)?.el.scrollIntoView({ block: 'start' });
    toast(`${sizes.length}ページを追加しました`);
  } catch (err) {
    toast('PDFを読み込めませんでした: ' + err.message, 6000);
  }
}

// ---------- ページ一覧(左のサイドバー) ----------
function toggleSidebar(on = !S.sidebar) {
  S.sidebar = on;
  savePrefs();
  refreshToolbar();
  $('#sb-scrim').hidden = !on;
  if (!S.note) { $('#sidebar').hidden = !on; return; }
  // 幅が変わるので、幅に合わせた表示ならページの大きさも合わせ直し、見ていた場所に戻す
  keepPosition(() => {
    $('#sidebar').hidden = !on;
    if (S.fit) S.zoom = fitZoom();
    layoutPages();
  });
  if (on) renderSidebar();
}

function renderSidebar() {
  S.thumbs = new Map();
  S.thumbIO?.disconnect();
  const list = $('#pp-list');
  list.innerHTML = '';
  if (!S.sidebar || !S.note) return;
  const pages = pagesOf(S.note);
  const cur = currentPage();
  curPageId = cur?.id;
  // サムネイルは見えているものだけ描く(ページが多いノート・PDF でも重くならないように)
  S.thumbIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting || en.target.dataset.drawn) continue;
      const pg = S.note && pagesOf(S.note).find((x) => x.id === en.target.dataset.id);
      if (pg) { en.target.dataset.drawn = '1'; drawThumb(en.target.querySelector('canvas'), pg); }
    }
  }, { root: list, rootMargin: '400px 0px' });
  pages.forEach((pg, i) => {
    const row = document.createElement('div');
    row.className = 'pp-row' + (cur && cur.id === pg.id ? ' current' : '');
    row.dataset.id = pg.id;
    row.innerHTML = `<button class="pp-go" title="${i + 1}ページ目を表示(長押しで並べ替え)"><canvas class="pp-thumb" width="240" height="${Math.round((240 * pg.h) / pg.w)}"></canvas></button>
      <div class="pp-info"><span class="pp-no">${i + 1}</span><button class="pp-menu icon-btn small" aria-haspopup="menu" title="ページの操作" aria-label="${i + 1}ページ目の操作">${icon('chevron', 16)}</button></div>`;
    list.appendChild(row);
    S.thumbs.set(pg.id, row);
    S.thumbIO.observe(row);
    const go = row.querySelector('.pp-go');
    go.onclick = (e) => {
      if (go._dragged) { go._dragged = false; e.preventDefault(); return; }
      S.views.get(pg.id)?.el.scrollIntoView({ block: 'start' });
      if (window.innerWidth <= 700) toggleSidebar(false);
    };
    bindThumbDrag(row, pg);
    const mb = row.querySelector('.pp-menu');
    mb.onclick = () => pageMenu(mb, pg);
    go.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!thumbDrag && !go._dragged) pageMenu(mb, pg); });
  });
  if (cur) thumbIntoView(cur.id, true);
}

// サイドバーの中だけをスクロールして、そのページのサムネイルを見せる
function thumbIntoView(id, center) {
  const list = $('#pp-list'), row = S.thumbs?.get(id);
  if (!row) return;
  const top = row.offsetTop, h = row.offsetHeight;
  if (center) list.scrollTop = top - (list.clientHeight - h) / 2;
  else if (top < list.scrollTop) list.scrollTop = top - 8;
  else if (top + h > list.scrollTop + list.clientHeight) list.scrollTop = top + h - list.clientHeight + 8;
}

// サムネイルを長押し(マウスはそのまま引っぱる)して、ページを並べ替える
let thumbDrag = null;
function bindThumbDrag(row, pg) {
  const go = row.querySelector('.pp-go');
  let st = null;
  const cancel = () => { if (st) clearTimeout(st.timer); st = null; };
  go.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || thumbDrag) return;
    st = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, timer: 0 };
    if (e.pointerType === 'mouse') try { go.setPointerCapture(e.pointerId); } catch {}
    if (e.pointerType !== 'mouse') st.timer = setTimeout(() => startThumbDrag(e, row, pg, go), 380);
  });
  go.addEventListener('pointermove', (e) => {
    if (thumbDrag && thumbDrag.row === row) return moveThumbDrag(e);
    if (!st || e.pointerId !== st.id) return;
    const d = Math.hypot(e.clientX - st.x, e.clientY - st.y);
    if (st.type === 'mouse' && d > 6) { const s0 = st; cancel(); startThumbDrag({ ...s0, clientX: e.clientX, clientY: e.clientY, pointerId: s0.id }, row, pg, go); }
    else if (st.type !== 'mouse' && d > 10) cancel(); // 一覧のスクロール
  });
  const up = (e) => {
    cancel();
    if (thumbDrag && thumbDrag.row === row) endThumbDrag(e.type === 'pointercancel');
  };
  go.addEventListener('pointerup', up);
  go.addEventListener('pointercancel', up);
}
function startThumbDrag(e, row, pg, go) {
  closePopover();
  try { go.setPointerCapture(e.pointerId); } catch {}
  navigator.vibrate?.(10);
  const list = $('#pp-list');
  const line = document.createElement('div');
  line.className = 'pp-drop';
  list.appendChild(line);
  row.classList.add('dragging');
  go._dragged = true;
  thumbDrag = { row, pg, line, y0: e.clientY, to: -1, scroll: 0 };
  moveThumbDrag(e);
}
function moveThumbDrag(e) {
  const d = thumbDrag, list = $('#pp-list');
  d.lastY = e.clientY;
  placeThumbDrag();
  // 端に近づいたら一覧を自動でスクロール(端に近いほど速く)
  const lr = list.getBoundingClientRect(), edge = 60;
  const k = e.clientY < lr.top + edge ? -(lr.top + edge - e.clientY) / edge : e.clientY > lr.bottom - edge ? (e.clientY - (lr.bottom - edge)) / edge : 0;
  d.scrollV = Math.sign(k) * Math.min(28, 4 + Math.abs(k) * 24);
  if (d.scrollV && !d.scroll) {
    const step = () => {
      const t = thumbDrag;
      if (!t || !t.scrollV) { if (t) t.scroll = 0; return; }
      const before = list.scrollTop;
      list.scrollTop += t.scrollV;
      t.y0 -= list.scrollTop - before;
      placeThumbDrag();
      t.scroll = requestAnimationFrame(step);
    };
    d.scroll = requestAnimationFrame(step);
  }
}
// 持ち上げた行と、落とす場所の線を、指の位置に合わせる
function placeThumbDrag() {
  const d = thumbDrag, list = $('#pp-list'), y = d.lastY;
  d.row.style.transform = `translateY(${y - d.y0}px)`;
  const rows = [...list.querySelectorAll('.pp-row')];
  let to = rows.length;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] === d.row) continue;
    const r = rows[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) { to = i; break; }
  }
  d.to = to;
  const ref = rows[to], last = rows[rows.length - 1];
  d.line.style.top = (ref ? ref.offsetTop - 8 : last.offsetTop + last.offsetHeight + 6) + 'px';
}
async function endThumbDrag(cancelled) {
  const d = thumbDrag;
  thumbDrag = null;
  cancelAnimationFrame(d.scroll);
  d.line.remove();
  d.row.classList.remove('dragging');
  d.row.style.transform = '';
  if (cancelled || d.to < 0) return;
  const pages = pagesOf(S.note);
  const i = pages.indexOf(d.pg);
  // 行の並び(自分を含む)で to の前に入れる → 自分を除いた並びでの前後
  if (d.to === i || d.to === i + 1) return;
  const rest = pages.filter((p) => p !== d.pg);
  const at = d.to > i ? d.to - 1 : d.to;
  const keepTop = $('#pp-list').scrollTop;
  await movePage(d.pg, rest[at - 1], rest[at], true);
  $('#pp-list').scrollTop = keepTop; // 続けて並べ替えやすいように、一覧の位置はそのまま
}
document.addEventListener('touchmove', (e) => { if (thumbDrag) e.preventDefault(); }, { passive: false });

function pageMenu(anchor, pg) {
  const pages = pagesOf(S.note);
  const i = pages.indexOf(pg);
  const bg = bgOf(pg);
  const items = [
    { icon: 'up', label: '前へ移動', attrs: { 'data-a': 'up' }, disabled: i === 0, onClick: () => movePage(pg, pages[i - 2], pages[i - 1]) },
    { icon: 'down', label: '後ろへ移動', attrs: { 'data-a': 'down' }, disabled: i === pages.length - 1, onClick: () => movePage(pg, pages[i + 1], pages[i + 2]) },
    '-',
    { icon: 'page', label: '前にページを追加…', onClick: () => openAddDialog('before', pg) },
    { icon: 'page', label: '後ろにページを追加…', onClick: () => openAddDialog('after', pg) },
    { icon: 'file', label: 'このページを複製', attrs: { 'data-a': 'dup' }, onClick: () => duplicatePage(pg) },
  ];
  if (bg && bg.type === 'blank') {
    const sel = document.createElement('label');
    sel.className = 'menu-select';
    sel.innerHTML = `<span class="menu-cap">このページの用紙</span><select class="pp-tpl">${TEMPLATES.map((t) => `<option value="${t.id}"${(bg.ruling === 'lines' ? 'lines-b' : bg.ruling) === t.id ? ' selected' : ''}>${t.label}</option>`).join('')}</select>`;
    sel.querySelector('select').onchange = async (e) => {
      const before = bgOf(pg);
      const nb = { type: 'blank', ruling: e.target.value };
      closePopover();
      await commit([mk('page.bg', { pageId: pg.id, bg: nb })]);
      pushUndo({ undo: [['page.bg', { pageId: pg.id, bg: before }]], redo: [['page.bg', { pageId: pg.id, bg: nb }]], pages: [pg.id], bg: true });
      repaintPage(pg.id);
    };
    items.push('-', { el: sel });
  }
  items.push('-', { icon: 'trash', label: 'ページを削除', danger: true, attrs: { 'data-a': 'del' }, disabled: pages.length <= 1, onClick: () => deletePage(pg.id) });
  openPopover(anchor, (body, close) => menu(body, items, close), { align: 'start' });
}

// 1ページだけ描き直す(背景・線・サムネイル)
function repaintPage(id) {
  const v = S.views.get(id);
  if (v && v.ready) { paintBg(v); paintInk(v); }
  const row = S.thumbs?.get(id), pg = pagesOf(S.note).find((x) => x.id === id);
  if (row && pg && row.dataset.drawn) drawThumb(row.querySelector('canvas'), pg);
}

// ページを複製(背景と線をそのまま写す)
async function duplicatePage(pg) {
  const pages = pagesOf(S.note);
  const i = pages.indexOf(pg);
  const next = pages[i + 1];
  const order = await freeOrder(pg, next);
  const id = newId();
  const ops = [mk('page.add', { page: { id, w: pg.w, h: pg.h, order, bg: bgOf(pg) } })];
  const ids = [];
  for (const e of strokesOf(S.note, pg.id)) {
    const nid = newId();
    ids.push(nid);
    ops.push(mk('stroke.add', { s: { ...e.data, id: nid, pageId: id } }));
    if (e.off[0] || e.off[1]) ops.push(mk('stroke.tf', { tf: { [nid]: e.off } }));
    if (e.color) ops.push(mk('stroke.style', { styles: { [nid]: { color: e.color } } }));
  }
  await commit(ops);
  pushUndo({ undo: [['page.delete', { pageId: id }]], redo: [['page.restore', { pageId: id }]], relayout: true });
  keepPosition(() => renderPages());
  S.views.get(id)?.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(`${i + 1}ページ目を複製しました`);
}

// a と b の間に入れる順番の値。間が詰まりすぎていたら、全ページの順番を振り直してから決める
async function freeOrder(a, b) {
  const ok = () => !(a && b) || (b.order - a.order > 1e-6 && (a.order + b.order) / 2 > a.order && (a.order + b.order) / 2 < b.order);
  if (!ok()) {
    const ops = pagesOf(S.note).map((p, i) => mk('page.move', { pageId: p.id, order: i + 1 }));
    await commit(ops);
  }
  return a && b ? (a.order + b.order) / 2 : a ? a.order + 1 : b ? b.order - 1 : 1;
}

// pg を a と b の間に動かす。quiet: 一覧で引っぱって動かしたとき(読んでいる場所はそのまま)
async function movePage(pg, a, b, quiet) {
  const order = await freeOrder(a, b);
  const before = pg.order; // 順番を振り直したあとの値で覚える
  await commit([mk('page.move', { pageId: pg.id, order })]);
  pushUndo({ undo: [['page.move', { pageId: pg.id, order: before }]], redo: [['page.move', { pageId: pg.id, order }]], relayout: true });
  if (quiet) return keepPosition(() => renderPages());
  renderPages();
  // メニューで動かしたときは、動かしたページを表示する
  S.views.get(pg.id)?.el.scrollIntoView({ block: 'start' });
  const n = pagesOf(S.note).indexOf(pg) + 1;
  toast(`${n}ページ目に移動しました`);
}

function drawThumb(canvas, pg) {
  const W = 120;
  canvas.width = W * 2;
  canvas.height = Math.round((W * 2 * pg.h) / pg.w);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const bg = bgOf(pg);
  const scale = canvas.width / pg.w;
  const draw = () => {
    const c2 = scaledCtx(canvas, pg);
    // 小さく描くと罫線が消えるので、画面で 0.8px 以上の太さにする
    if (bg?.type === 'blank') paintTemplate(c2, bg, pg.w, pg.h, 1.6 / scale);
    for (const e of strokesOf(S.note, pg.id)) drawStroke(c2, styleOf(e), e.off, geoOf(e));
  };
  if (bg?.type === 'pdf') {
    // 前の描画が終わっていなければ止める
    canvas._holder?.task?.cancel?.();
    const holder = (canvas._holder = {});
    renderPdfPage(canvas, bg.hash, bg.page, holder).then(() => { if (canvas._holder === holder) draw(); }).catch(() => { if (canvas._holder === holder) draw(); });
  } else draw();
}

// 右下のページ表示を押すと、ページ番号を入れて移動できる
function gotoPagePopover(anchor) {
  const pages = pagesOf(S.note);
  openPopover(anchor, (body, close) => {
    body.classList.add('goto-pop');
    body.innerHTML = `<form class="goto"><label><span class="menu-cap">ページへ移動(1〜${pages.length})</span><input type="number" min="1" max="${pages.length}" inputmode="numeric"></label><button type="submit" class="primary">移動</button></form>`;
    const inp = body.querySelector('input');
    inp.value = (currentPage() ? pages.indexOf(currentPage()) : 0) + 1;
    body.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const n = Math.max(1, Math.min(pages.length, Math.round(+inp.value || 1)));
      close();
      S.views.get(pages[n - 1].id)?.el.scrollIntoView({ block: 'start' });
    };
    setTimeout(() => { inp.focus(); inp.select(); });
  }, { align: 'end' });
}

init().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<p style="padding:24px">起動できませんでした: ${esc(e.message)}</p>`;
});
