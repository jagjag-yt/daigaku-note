import * as db from './db.js';
import { Recorder, emptyNote, applyOp, pagesOf, strokesOf, buildLibrary, newId, strokeHit, widthAt, PAGE_A4 } from './model.js';
import { importPdf, renderPdfPage, exportPdf, rulingLines, RULING_COLOR } from './pdf.js';
import { buildSyncFile, importSyncFile } from './sync.js';

const $ = (s) => document.querySelector(s);
const COLORS = ['#1f2937', '#2563eb', '#dc2626', '#16a34a', '#f59e0b'];
const WIDTHS = [1.2, 2.2, 4];
const MAX_CANVAS_PX = 4_000_000; // iPad Safari のキャンバス上限を避ける

const S = {
  rec: null,
  note: null,
  zoom: 1,
  tool: 'pen',
  color: COLORS[0],
  width: WIDTHS[1],
  fingerDraw: false,
  undo: [],
  redo: [],
  views: new Map(), // pageId -> view
  io: null,
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
  if (prefs.color) S.color = prefs.color;
  if (prefs.width) S.width = prefs.width;

  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  buildToolbar();
  bindLibrary();
  bindEditor();
  window.addEventListener('hashchange', route);
  route();
}

function savePrefs() {
  db.setMeta('prefs', { fingerDraw: S.fingerDraw, color: S.color, width: S.width });
}

function route() {
  const m = location.hash.match(/^#\/note\/(\w+)/);
  if (m) openNote(m[1]);
  else showLibrary();
}

function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
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

// ---------- op の記録 ----------
function mk(t, p, n = S.note.id) {
  return S.rec.make(n, t, p);
}
async function commit(ops) {
  for (const op of ops) if (S.note && op.n === S.note.id) applyOp(S.note, op);
  try {
    await db.putOps(ops, S.rec.clock);
    setSaved(true);
  } catch (e) {
    setSaved(false);
    toast('保存に失敗しました: ' + e.message, 6000);
  }
}
function setSaved(ok) {
  const el = $('#saved');
  if (el) el.textContent = ok ? '端末に保存済み' : '保存エラー';
}

// ---------- ノート一覧 ----------
function bindLibrary() {
  $('#new-note').onclick = async () => {
    const title = prompt('ノートの名前', '無題のノート');
    if (title == null) return;
    const id = newId();
    const ruling = $('#new-ruling').value;
    const ops = [
      S.rec.make(id, 'note.create', { title: title.trim() || '無題のノート' }),
      S.rec.make(id, 'page.add', { page: { id: newId(), w: PAGE_A4.w, h: PAGE_A4.h, order: 1, bg: { type: 'blank', ruling } } }),
    ];
    await db.putOps(ops, S.rec.clock);
    location.hash = '#/note/' + id;
  };
  $('#open-pdf').onclick = () => $('#pdf-input').click();
  $('#pdf-input').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      toast('PDFを読み込み中…', 60000);
      const { hash, sizes } = await importPdf(file);
      const id = newId();
      const ops = [S.rec.make(id, 'note.create', { title: file.name.replace(/\.pdf$/i, '') })];
      sizes.forEach((sz, i) => ops.push(S.rec.make(id, 'page.add', { page: { id: newId(), w: sz.w, h: sz.h, order: i + 1, bg: { type: 'pdf', hash, page: i + 1 } } })));
      await db.putOps(ops, S.rec.clock);
      toast(`${sizes.length}ページのPDFを読み込みました`);
      location.hash = '#/note/' + id;
    } catch (err) {
      toast('PDFを読み込めませんでした: ' + err.message, 6000);
    }
  };
  $('#sync-btn').onclick = () => {
    $('#device-id').textContent = S.rec.device;
    $('#sync-dialog').showModal();
  };
  $('#sync-close').onclick = () => $('#sync-dialog').close();
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
      }
      toast(added ? `${added}件の新しい変更を取り込みました(全${total}件)` : 'すべて取り込み済みでした');
      $('#sync-dialog').close();
      route();
    } catch (err) {
      toast('取り込めませんでした: ' + err.message, 6000);
    }
  };
}

function coverColor(id) {
  const palette = ['#2f5d9e', '#b33a3a', '#2f7d5b', '#7a4fa0', '#c27c1a', '#3a6f7a'];
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

async function showLibrary() {
  closeEditor();
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
  for (const n of notes) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <a class="cover" href="#/note/${n.id}" style="--cover:${coverColor(n.id)}">
        <span class="label"><span class="label-title"></span></span>
        <span class="brand">大学ノート</span>
      </a>
      <div class="meta"><div class="name"></div><div class="date"></div></div>
      <div class="actions">
        <button data-act="rename" title="名前を変える">名前</button>
        <button data-act="export" title="このノートだけ書き出す">書き出し</button>
        <button data-act="delete" title="削除" class="danger">削除</button>
      </div>`;
    card.querySelector('.label-title').textContent = n.title;
    card.querySelector('.name').textContent = n.title;
    const t = upd.get(n.id);
    card.querySelector('.date').textContent = t ? new Date(t).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '';
    card.querySelector('[data-act=rename]').onclick = async () => {
      const title = prompt('新しい名前', n.title);
      if (!title || title === n.title) return;
      await db.putOps([S.rec.make(n.id, 'note.rename', { title })], S.rec.clock);
      showLibrary();
    };
    card.querySelector('[data-act=export]').onclick = async () => {
      const json = await buildSyncFile(S.rec.device, n.id);
      download(JSON.stringify(json), `${safeName(n.title)}.daigaku.json`, 'application/json');
    };
    card.querySelector('[data-act=delete]').onclick = async () => {
      if (!confirm(`「${n.title}」を削除しますか?`)) return;
      await db.putOps([S.rec.make(n.id, 'note.delete', {})], S.rec.clock);
      showLibrary();
      toast('削除しました');
    };
    grid.appendChild(card);
  }
}

// ---------- エディタ ----------
function buildToolbar() {
  const sw = $('#colors');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.setProperty('--c', c);
    b.dataset.color = c;
    b.title = '色';
    b.onclick = () => { S.color = c; setTool('pen'); savePrefs(); refreshToolbar(); };
    sw.appendChild(b);
  }
  const ws = $('#widths');
  WIDTHS.forEach((w) => {
    const b = document.createElement('button');
    b.className = 'width';
    b.dataset.width = w;
    b.title = '太さ';
    b.innerHTML = `<span style="height:${Math.round(w * 1.6) + 1}px"></span>`;
    b.onclick = () => { S.width = w; setTool('pen'); savePrefs(); refreshToolbar(); };
    ws.appendChild(b);
  });
}

function setTool(t) {
  S.tool = t;
  refreshToolbar();
}

function refreshToolbar() {
  $('#tool-pen').classList.toggle('on', S.tool === 'pen');
  $('#tool-eraser').classList.toggle('on', S.tool === 'eraser');
  document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b.dataset.color === S.color));
  document.querySelectorAll('.width').forEach((b) => b.classList.toggle('on', +b.dataset.width === S.width));
  $('#finger').classList.toggle('on', S.fingerDraw);
  $('#undo').disabled = !S.undo.length;
  $('#redo').disabled = !S.redo.length;
  $('#zoom-label').textContent = Math.round(S.zoom * 100) + '%';
}

function bindEditor() {
  $('#back').onclick = () => (location.hash = '#/');
  $('#tool-pen').onclick = () => setTool('pen');
  $('#tool-eraser').onclick = () => setTool('eraser');
  $('#finger').onclick = () => { S.fingerDraw = !S.fingerDraw; savePrefs(); refreshToolbar(); toast(S.fingerDraw ? '指でも書けるようにしました' : 'ペンだけで書けるようにしました(指はスクロール)'); };
  $('#undo').onclick = undo;
  $('#redo').onclick = redo;
  $('#zoom-in').onclick = () => setZoom(S.zoom * 1.25);
  $('#zoom-out').onclick = () => setZoom(S.zoom / 1.25);
  $('#zoom-label').onclick = () => setZoom(fitZoom());
  $('#add-page').onclick = addPage;
  $('#add-pdf').onclick = () => $('#pdf-add-input').click();
  $('#pdf-add-input').onchange = addPdfPages;
  $('#export-pdf').onclick = async () => {
    try {
      toast('PDFを作っています…', 60000);
      const bytes = await exportPdf(S.note);
      download(new Blob([bytes], { type: 'application/pdf' }), `${safeName(S.note.title)}.pdf`);
      toast('PDFを書き出しました');
    } catch (e) {
      toast('PDFを書き出せませんでした: ' + e.message, 6000);
    }
  };
  $('#title').onclick = async () => {
    const title = prompt('ノートの名前', S.note.title);
    if (!title || title === S.note.title) return;
    await commit([mk('note.rename', { title })]);
    $('#title').textContent = S.note.title;
    document.title = S.note.title + ' - 大学ノート';
  };
  document.addEventListener('keydown', (e) => {
    if ($('#editor').hidden) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (!mod && e.key === 'p') setTool('pen');
    else if (!mod && e.key === 'e') setTool('eraser');
  });
  bindInput();
  window.addEventListener('resize', () => { if (S.note) layoutPages(); });
}

async function openNote(id) {
  closeEditor();
  const ops = await db.opsForNote(id);
  const note = emptyNote(id);
  for (const op of ops) applyOp(note, op);
  if (!note.titleS) { location.hash = '#/'; return; }
  S.note = note;
  S.undo = [];
  S.redo = [];
  $('#library').hidden = true;
  $('#editor').hidden = false;
  $('#title').textContent = note.title;
  document.title = note.title + ' - 大学ノート';
  setSaved(true);
  S.zoom = fitZoom();
  renderPages();
  $('#scroller').scrollTop = 0;
  refreshToolbar();
}

function closeEditor() {
  if (S.io) S.io.disconnect();
  for (const v of S.views.values()) releaseView(v);
  S.views.clear();
  S.note = null;
  const pages = $('#pages');
  if (pages) pages.innerHTML = '';
}

function fitZoom() {
  const sc = $('#scroller');
  const pages = S.note ? pagesOf(S.note) : [];
  const maxW = Math.max(PAGE_A4.w, ...pages.map((p) => p.w));
  const avail = (sc.clientWidth || window.innerWidth) - 32;
  return clampZoom(Math.min(avail / maxW, 1.5));
}
const clampZoom = (z) => Math.max(0.3, Math.min(4, z));

function renderPages() {
  const wrap = $('#pages');
  if (S.io) S.io.disconnect();
  for (const v of S.views.values()) releaseView(v);
  S.views.clear();
  wrap.innerHTML = '';
  S.io = new IntersectionObserver(onIntersect, { root: $('#scroller'), rootMargin: '800px 0px' });
  const pages = pagesOf(S.note);
  pages.forEach((pg, i) => {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.id = pg.id;
    el.innerHTML = `<canvas class="bg"></canvas><canvas class="ink"></canvas>
      <div class="page-foot"><span>${i + 1} / ${pages.length}</span><button class="del-page" title="このページを削除">ページを削除</button></div>`;
    el.querySelector('.del-page').onclick = () => deletePage(pg.id);
    wrap.appendChild(el);
    const v = { pg, el, bg: el.querySelector('.bg'), ink: el.querySelector('.ink'), visible: false, ready: false, holder: {} };
    S.views.set(pg.id, v);
    sizeView(v);
    S.io.observe(el);
  });
}

function sizeView(v) {
  v.el.style.width = v.pg.w * S.zoom + 'px';
  v.el.style.height = v.pg.h * S.zoom + 'px';
}

function layoutPages() {
  for (const v of S.views.values()) {
    sizeView(v);
    if (v.visible) paintView(v);
  }
  refreshToolbar();
}

function setZoom(z, focus) {
  z = clampZoom(z);
  const sc = $('#scroller');
  const fx = focus ? focus.x : sc.clientWidth / 2;
  const fy = focus ? focus.y : sc.clientHeight / 2;
  const cx = (sc.scrollLeft + fx) / S.zoom, cy = (sc.scrollTop + fy) / S.zoom;
  S.zoom = z;
  layoutPages();
  sc.scrollLeft = cx * z - fx;
  sc.scrollTop = cy * z - fy;
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
  v.ink.width = v.ink.height = 0;
  v.ready = false;
}

function paintView(v) {
  const dpr = window.devicePixelRatio || 1;
  let cw = v.pg.w * S.zoom * dpr, ch = v.pg.h * S.zoom * dpr;
  const k = Math.min(1, Math.sqrt(MAX_CANVAS_PX / (cw * ch)));
  cw = Math.round(cw * k);
  ch = Math.round(ch * k);
  for (const c of [v.bg, v.ink]) { c.width = cw; c.height = ch; }
  v.ready = true;
  paintBg(v);
  paintInk(v);
}

function paintBg(v) {
  const c = v.bg, ctx = c.getContext('2d'), bg = v.pg.bg;
  v.holder.task?.cancel?.();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  if (bg && bg.type === 'pdf') {
    renderPdfPage(c, bg.hash, bg.page, v.holder).catch((e) => {
      ctx.fillStyle = '#999';
      ctx.font = `${14 * c.width / v.pg.w}px sans-serif`;
      ctx.fillText(e.message, 20, 40);
    });
    return;
  }
  const s = c.width / v.pg.w;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.strokeStyle = RULING_COLOR;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (const [x0, y0, x1, y1] of rulingLines(bg, v.pg.w, v.pg.h)) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
  ctx.stroke();
}

function inkCtx(v) {
  const ctx = v.ink.getContext('2d');
  const s = v.ink.width / v.pg.w;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return ctx;
}

function paintInk(v, hidden) {
  if (!v.ready) return;
  const ctx = v.ink.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, v.ink.width, v.ink.height);
  const c2 = inkCtx(v);
  for (const e of strokesOf(S.note, v.pg.id, hidden)) drawStroke(c2, e.data);
}

// 線の描き方: 点 P0..Pn-1 の中点 M をつないだ二次ベジエ。1区間ずつ太さを変える。
function drawPiece(ctx, d, k, n) {
  const P = d.pts;
  const x = (i) => P[i * 3], y = (i) => P[i * 3 + 1], p = (i) => P[i * 3 + 2];
  const mx = (i) => (x(i) + x(i + 1)) / 2, my = (i) => (y(i) + y(i + 1)) / 2;
  ctx.strokeStyle = d.color;
  ctx.beginPath();
  if (k === 0) {
    ctx.lineWidth = widthAt(d, p(0));
    ctx.moveTo(x(0), y(0));
    ctx.lineTo(mx(0), my(0));
  } else if (k === n - 1) {
    ctx.lineWidth = widthAt(d, p(n - 1));
    ctx.moveTo(mx(n - 2), my(n - 2));
    ctx.lineTo(x(n - 1), y(n - 1));
  } else {
    ctx.lineWidth = widthAt(d, p(k));
    ctx.moveTo(mx(k - 1), my(k - 1));
    ctx.quadraticCurveTo(x(k), y(k), mx(k), my(k));
  }
  ctx.stroke();
}
function drawDot(ctx, d) {
  ctx.fillStyle = d.color;
  ctx.beginPath();
  ctx.arc(d.pts[0], d.pts[1], widthAt(d, d.pts[2]) / 2, 0, Math.PI * 2);
  ctx.fill();
}
function drawStroke(ctx, d) {
  const n = d.pts.length / 3;
  if (n === 1) return drawDot(ctx, d);
  for (let k = 0; k < n; k++) drawPiece(ctx, d, k, n);
}

// ---------- 入力(ペン・マウス・指) ----------
let active = null; // 書いている最中の線 / 消している最中
const touches = new Map();
let pinch = null, inertia = null, lastPenTime = 0;

function bindInput() {
  const sc = $('#scroller');
  // iPad Safari: Apple Pencil でスクロールしないようにする
  sc.addEventListener('touchstart', (e) => {
    if ([...e.touches].some((t) => t.touchType === 'stylus')) e.preventDefault();
  }, { passive: false });
  sc.addEventListener('touchmove', (e) => { if (active || touches.size) e.preventDefault(); }, { passive: false });
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

function pagePoint(v, e) {
  const r = v.el.getBoundingClientRect();
  return [(e.clientX - r.left) / S.zoom, (e.clientY - r.top) / S.zoom];
}

function onDown(e) {
  if (!S.note) return;
  const isTouch = e.pointerType === 'touch';
  // ペンを使ってすぐの指は手のひらとみなして無視
  if (isTouch && !S.fingerDraw) return gestureDown(e);
  if (isTouch && Date.now() - lastPenTime < 500) return;
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
  const eraser = S.tool === 'eraser' || (e.buttons & 32) || e.button === 5;
  if (eraser) {
    active = { id: e.pointerId, v, eraser: true, hits: new Set() };
    eraseAt(e);
  } else {
    const d = { id: newId(), pageId: v.pg.id, color: S.color, width: S.width, pr: e.pointerType === 'pen', pts: [] };
    active = { id: e.pointerId, v, d, ctx: inkCtx(v) };
    addPoint(e);
  }
}

function onMove(e) {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) return gestureMove(e);
  if (!active || e.pointerId !== active.id) return;
  if (e.pointerType === 'pen') lastPenTime = Date.now();
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs.length ? evs : [e]) active.eraser ? eraseAt(ev) : addPoint(ev);
}

function addPoint(e) {
  const a = active, d = a.d;
  const [x, y] = pagePoint(a.v, e);
  const n0 = d.pts.length / 3;
  if (n0) {
    const lx = d.pts[d.pts.length - 3], ly = d.pts[d.pts.length - 2];
    if (Math.hypot(x - lx, y - ly) < 0.6 / S.zoom) return; // 近すぎる点は捨てる
  }
  const p = d.pr ? (e.pressure || 0.5) : 0.5;
  d.pts.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(p * 100) / 100);
  const n = n0 + 1;
  if (n === 1) drawDot(a.ctx, d);
  else if (n === 2) drawPiece(a.ctx, d, 0, 99);
  else drawPiece(a.ctx, d, n - 2, 99);
}

function eraseAt(e) {
  const a = active;
  const [x, y] = pagePoint(a.v, e);
  const r = 9 / S.zoom;
  let changed = false;
  for (const st of strokesOf(S.note, a.v.pg.id, a.hits)) {
    if (strokeHit(st, x, y, r)) { a.hits.add(st.id); changed = true; }
  }
  if (changed) paintInk(a.v, a.hits);
}

async function onUp(e) {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) return gestureUp(e);
  if (!active || e.pointerId !== active.id) return;
  const a = active;
  active = null;
  if (a.eraser) {
    if (!a.hits.size) return;
    const ids = [...a.hits];
    pushUndo({ undo: [['stroke.undel', { ids }]], redo: [['stroke.del', { ids }]], pages: [a.v.pg.id] });
    await commit([mk('stroke.del', { ids })]);
    paintInk(a.v);
    return;
  }
  const d = a.d, n = d.pts.length / 3;
  if (!n) return;
  if (n >= 2) drawPiece(a.ctx, d, n - 1, n);
  pushUndo({ undo: [['stroke.del', { ids: [d.id] }]], redo: [['stroke.undel', { ids: [d.id] }]], pages: [a.v.pg.id] });
  await commit([mk('stroke.add', { s: d })]);
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
  if (entry.relayout) renderPages();
  else for (const id of entry.pages || []) { const v = S.views.get(id); if (v) paintInk(v); }
  refreshToolbar();
}
async function undo() {
  const e = S.undo.pop();
  if (!e) return;
  S.redo.push(e);
  await runEntry(e.undo, e);
}
async function redo() {
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

async function addPage() {
  const pages = pagesOf(S.note);
  const cur = currentPage() || pages[pages.length - 1];
  const i = pages.indexOf(cur);
  const next = pages[i + 1];
  const order = cur ? (next ? (cur.order + next.order) / 2 : cur.order + 1) : 1;
  const ruling = cur && cur.bg && cur.bg.type === 'blank' ? cur.bg.ruling : 'lines';
  const w = cur && cur.bg?.type === 'blank' ? cur.w : PAGE_A4.w, h = cur && cur.bg?.type === 'blank' ? cur.h : PAGE_A4.h;
  const id = newId();
  await commit([mk('page.add', { page: { id, w, h, order, bg: { type: 'blank', ruling } } })]);
  pushUndo({ undo: [['page.delete', { pageId: id }]], redo: [['page.restore', { pageId: id }]], relayout: true });
  const top = $('#scroller').scrollTop;
  renderPages();
  $('#scroller').scrollTop = top;
  S.views.get(id)?.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deletePage(id) {
  if (pagesOf(S.note).length <= 1) return toast('最後の1ページは削除できません');
  if (!confirm('このページを削除しますか?(元に戻すで復活できます)')) return;
  await commit([mk('page.delete', { pageId: id })]);
  pushUndo({ undo: [['page.restore', { pageId: id }]], redo: [['page.delete', { pageId: id }]], relayout: true });
  const top = $('#scroller').scrollTop;
  renderPages();
  $('#scroller').scrollTop = top;
}

async function addPdfPages(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    toast('PDFを読み込み中…', 60000);
    const { hash, sizes } = await importPdf(file);
    const pages = pagesOf(S.note);
    let order = pages.length ? pages[pages.length - 1].order : 0;
    const ops = sizes.map((sz, i) => mk('page.add', { page: { id: newId(), w: sz.w, h: sz.h, order: ++order, bg: { type: 'pdf', hash, page: i + 1 } } }));
    await commit(ops);
    pushUndo({ undo: ops.map((o) => ['page.delete', { pageId: o.p.page.id }]), redo: ops.map((o) => ['page.restore', { pageId: o.p.page.id }]), relayout: true });
    renderPages();
    S.views.get(ops[0].p.page.id)?.el.scrollIntoView({ block: 'start' });
    toast(`${sizes.length}ページ追加しました`);
  } catch (err) {
    toast('PDFを読み込めませんでした: ' + err.message, 6000);
  }
}

init().catch((e) => {
  document.body.innerHTML = `<p style="padding:24px">起動できませんでした: ${e.message}</p>`;
});
