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

const $ = (s) => document.querySelector(s);
const PEN_COLORS = ['#1f2937', '#2563eb', '#dc2626', '#16a34a', '#f59e0b'];
const MARKER_COLORS = ['#fde047', '#86efac', '#f9a8d4', '#93c5fd', '#fdba74'];
const PEN_WIDTHS = [1.2, 2.2, 4];
const MARKER_WIDTHS = [8, 14, 22];
const MAX_CANVAS_PX = 4_000_000; // iPad Safari のキャンバス上限を避ける

const S = {
  rec: null,
  note: null,
  zoom: 1,
  tool: 'pen', // pen | marker | eraser | lasso
  pen: { color: PEN_COLORS[0], width: PEN_WIDTHS[1] },
  marker: { color: MARKER_COLORS[0], width: MARKER_WIDTHS[1] },
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

  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  fillSelects();
  bindLibrary();
  bindEditor();
  bindPagesPanel();
  await dav.init({ recorder: S.rec, onRemoteChange: onRemoteChange, onStatus: setSyncStatus });
  search.init({ onProgress: (msg) => { const el = $('#search-status'); if (el) el.textContent = msg; } });
  window.addEventListener('hashchange', route);
  route();
}

function savePrefs() {
  db.setMeta('prefs', { fingerDraw: S.fingerDraw, shapes: S.shapes, pen: S.pen, marker: S.marker });
}

function route() {
  flushPen();
  const m = location.hash.match(/^#\/note\/(\w+)(?:\/p\/(\w+))?/);
  if (m) openNote(m[1], m[2]);
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
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fillSelects() {
  for (const sel of document.querySelectorAll('select.tpl-select')) {
    sel.innerHTML = TEMPLATES.map((t) => `<option value="${t.id}">${t.label}</option>`).join('');
    sel.value = 'lines-b';
  }
  for (const sel of document.querySelectorAll('select.size-select')) {
    sel.innerHTML = SIZES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
  }
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
  } catch (e) {
    setSaved(false);
    toast('保存に失敗しました: ' + e.message, 6000);
  }
}
function setSaved(ok) {
  const el = $('#saved');
  if (el) el.textContent = ok ? '端末に保存済み' : '保存エラー';
}
function setSyncStatus(msg) {
  for (const el of document.querySelectorAll('.sync-status')) el.textContent = msg;
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
  $('#new-note').onclick = () => {
    $('#nn-title').value = '';
    $('#new-dialog').showModal();
    $('#nn-title').focus();
  };
  $('#nn-cancel').onclick = () => $('#new-dialog').close();
  $('#new-form').onsubmit = async (e) => {
    e.preventDefault();
    const title = $('#nn-title').value.trim() || '無題のノート';
    const size = sizeById($('#nn-size').value);
    const ruling = $('#nn-tpl').value;
    const id = newId();
    const ops = [
      S.rec.make(id, 'note.create', { title }),
      S.rec.make(id, 'page.add', { page: { id: newId(), w: size.w, h: size.h, order: 1, bg: { type: 'blank', ruling } } }),
    ];
    await db.putOps(ops, S.rec.clock);
    dav.schedule();
    $('#new-dialog').close();
    location.hash = '#/note/' + id;
  };
  $('#open-pdf').onclick = () => $('#pdf-input').click();
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
  $('#open-gn').onclick = () => $('#gn-input').click();
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
    $('#sync-dialog').showModal();
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

async function runSearch() {
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
  box.hidden = false;
  $('#notes').hidden = true;
  if (!hits.length) {
    box.innerHTML = `<p class="empty">「${esc(q)}」は見つかりませんでした。</p>`;
    return;
  }
  box.innerHTML = hits.slice(0, 100).map((h) => `
    <a class="hit" href="#/note/${h.noteId}${h.pageId ? '/p/' + h.pageId : ''}">
      <span class="hit-title">${esc(h.title)}${h.pageNo ? ` <span class="hit-page">${h.pageNo}ページ目</span>` : ''}</span>
      <span class="hit-snip">${h.snippet}</span>
      <span class="hit-src">${h.source}</span>
    </a>`).join('');
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
        <button data-act="rename" title="名前を変更">名前</button>
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
      dav.schedule();
      showLibrary();
    };
    card.querySelector('[data-act=export]').onclick = async () => {
      const json = await buildSyncFile(S.rec.device, n.id);
      download(JSON.stringify(json), `${safeName(n.title)}.daigaku.json`, 'application/json');
    };
    card.querySelector('[data-act=delete]').onclick = async () => {
      if (!confirm(`「${n.title}」を削除しますか?`)) return;
      await db.putOps([S.rec.make(n.id, 'note.delete', {})], S.rec.clock);
      dav.schedule();
      showLibrary();
      toast('削除しました');
    };
    grid.appendChild(card);
  }
  if ($('#search').value.trim()) runSearch();
}

// ---------- エディタのツールバー ----------
const toolState = () => (S.tool === 'marker' ? S.marker : S.pen);

function refreshToolbar() {
  for (const t of ['pen', 'marker', 'eraser', 'lasso']) $('#tool-' + t).classList.toggle('on', S.tool === t);
  const marker = S.tool === 'marker';
  const st = toolState();
  const colors = marker ? MARKER_COLORS : PEN_COLORS;
  const sw = $('#colors');
  sw.innerHTML = '';
  for (const c of colors) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === st.color ? ' on' : '');
    b.style.setProperty('--c', c);
    b.title = '色';
    b.onclick = () => {
      if (S.sel && S.tool === 'lasso') return recolorSelection(c);
      toolState().color = c;
      if (S.tool !== 'pen' && S.tool !== 'marker') S.tool = 'pen';
      savePrefs();
      refreshToolbar();
    };
    sw.appendChild(b);
  }
  const ws = $('#widths');
  ws.innerHTML = '';
  (marker ? MARKER_WIDTHS : PEN_WIDTHS).forEach((w) => {
    const b = document.createElement('button');
    b.className = 'width' + (w === st.width ? ' on' : '');
    b.title = '太さ';
    b.innerHTML = `<span style="height:${Math.min(14, Math.round(w * (marker ? 0.6 : 1.6)) + 1)}px"></span>`;
    b.onclick = () => {
      toolState().width = w;
      if (S.tool !== 'pen' && S.tool !== 'marker') S.tool = 'pen';
      savePrefs();
      refreshToolbar();
    };
    ws.appendChild(b);
  });
  $('#finger').classList.toggle('on', S.fingerDraw);
  $('#shapes').classList.toggle('on', S.shapes);
  $('#undo').disabled = !S.undo.length;
  $('#redo').disabled = !S.redo.length;
  $('#zoom-label').textContent = Math.round(S.zoom * 100) + '%';
}

function setTool(t) {
  if (t !== 'lasso') clearSelection();
  S.tool = t;
  refreshToolbar();
}

function bindEditor() {
  $('#back').onclick = () => (location.hash = '#/');
  for (const t of ['pen', 'marker', 'eraser', 'lasso']) $('#tool-' + t).onclick = () => setTool(t);
  $('#finger').onclick = () => {
    S.fingerDraw = !S.fingerDraw;
    savePrefs();
    refreshToolbar();
    toast(S.fingerDraw ? '指でも書けるようにしました' : 'ペンだけで書けるようにしました(指はスクロール)');
  };
  $('#shapes').onclick = () => {
    S.shapes = !S.shapes;
    savePrefs();
    refreshToolbar();
    toast(S.shapes ? '図形補正をオンにしました(書き終わりでペンを止めると図形に整えます)' : '図形補正をオフにしました');
  };
  $('#undo').onclick = undo;
  $('#redo').onclick = redo;
  $('#zoom-in').onclick = () => setZoom(S.zoom * 1.25);
  $('#zoom-out').onclick = () => setZoom(S.zoom / 1.25);
  $('#zoom-label').onclick = () => setZoom(fitZoom());
  $('#add-page').onclick = () => addPage();
  $('#pages-btn').onclick = openPagesPanel;
  $('#add-pdf').onclick = () => $('#pdf-add-input').click();
  $('#pdf-add-input').onchange = addPdfPages;
  $('#export-pdf').onclick = async () => {
    try {
      toast('PDFを作成しています…', 60000);
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
    if ($('#editor').hidden || e.target.closest('input, select, textarea, dialog')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (!mod && k === 'p') setTool('pen');
    else if (!mod && k === 'h') setTool('marker');
    else if (!mod && k === 'e') setTool('eraser');
    else if (!mod && k === 'l') setTool('lasso');
    else if ((k === 'delete' || k === 'backspace') && S.sel) deleteSelection();
    else if (k === 'escape') clearSelection();
  });
  bindInput();
  window.addEventListener('resize', () => { if (S.note) layoutPages(); });
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
    S.zoom = fitZoom();
    renderPages();
    $('#scroller').scrollTop = 0;
    refreshToolbar();
  }
  if (pageId) S.views.get(pageId)?.el.scrollIntoView({ block: 'start' });
}

function closeEditor() {
  if (S.io) S.io.disconnect();
  for (const v of S.views.values()) releaseView(v);
  S.views.clear();
  S.note = null;
  S.sel = null;
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
      <svg class="ink" xmlns="${SVGNS}" viewBox="0 0 ${pg.w} ${pg.h}" preserveAspectRatio="none"><g class="tpl"></g><g class="strokes"></g><g class="live"></g></svg>
      <div class="page-foot"><span>${i + 1} / ${pages.length}</span><button class="del-page" title="このページを削除">ページを削除</button></div>`;
    el.querySelector('.del-page').onclick = () => deletePage(pg.id);
    wrap.appendChild(el);
    const v = {
      pg, el, bg: el.querySelector('.bg'), tpl: el.querySelector('.tpl'), strokes: el.querySelector('.strokes'),
      live: el.querySelector('.live'), els: new Map(), visible: false, ready: false, holder: {}, bgZoom: 0,
    };
    S.views.set(pg.id, v);
    sizeView(v);
    S.io.observe(el);
  });
}

function sizeView(v) {
  v.el.style.width = v.pg.w * S.zoom + 'px';
  v.el.style.height = v.pg.h * S.zoom + 'px';
}

let bgTimer = 0;
function layoutPages() {
  for (const v of S.views.values()) sizeView(v);
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

function templateSvg(bg, w, h) {
  const prim = templatePrims(bg, w, h);
  const groups = new Map();
  for (const [x0, y0, x1, y1, t, c] of prim.lines) {
    const k = `${t}|${c}`;
    groups.set(k, (groups.get(k) || '') + `M${x0.toFixed(2)} ${y0.toFixed(2)}L${x1.toFixed(2)} ${y1.toFixed(2)}`);
  }
  let out = '';
  for (const [k, d] of groups) {
    const [t, c] = k.split('|');
    out += `<path d="${d}" stroke="${c}" stroke-width="${t}" fill="none"/>`;
  }
  if (prim.dots.length) {
    const [, , r, c] = prim.dots[0];
    out += `<path d="${prim.dots.map(([x, y]) => `M${x.toFixed(2)} ${y.toFixed(2)}h0`).join('')}" stroke="${c}" stroke-width="${r * 2}" stroke-linecap="round" fill="none"/>`;
  }
  return out;
}

// サムネイル用(キャンバス)
function paintTemplate(ctx, bg, w, h) {
  const prim = templatePrims(bg, w, h);
  for (const [x0, y0, x1, y1, t, c] of prim.lines) {
    ctx.strokeStyle = c;
    ctx.lineWidth = t;
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
// pointerup(本当に離したかもしれない)は厳しめ、pointercancel(システムが止めた)はゆるめに待つ
const PEN_JOIN = { up: { ms: 120, px: 48 }, cancel: { ms: 400, px: 64 } };
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
  el.textContent = 'v9\n' + Object.entries(debugCounts).map(([a, b]) => `${a} ${b}`).join('\n') + '\n' + debugGaps.join('\n');
}
// 書いている線の入力の中身(1回の move にまとめられた点の数、座標が整数か、筆圧)
const debugOn = /[?&]debug/.test(location.search);
const dbgIn = { frames: 0, co: 0, coInt: 0, mainInt: 0, p0: 0, pr: new Set(), skipped: 0, at: [0, 0, 0] };
function debugInput(e, evs) {
  const isInt = (ev) => Number.isInteger(ev.clientX) && Number.isInteger(ev.clientY);
  dbgIn.frames++;
  dbgIn.co += evs.length;
  dbgIn.coInt += evs.filter(isInt).length;
  if (isInt(e)) dbgIn.mainInt++;
  evs.forEach((ev, i) => { if (isInt(ev)) dbgIn.at[i === 0 ? 0 : i === evs.length - 1 ? 2 : 1]++; });
  for (const ev of evs) { if (!(ev.pressure > 0)) dbgIn.p0++; dbgIn.pr.add(Math.round(ev.pressure * 1000)); }
  const last = evs[evs.length - 1];
  debugCounts['move'] = `${dbgIn.frames} 点/回 ${(dbgIn.co / dbgIn.frames).toFixed(1)} 整数 ${dbgIn.coInt}/${dbgIn.co} 本体整数 ${dbgIn.mainInt} 筆圧0 ${dbgIn.p0} 筆圧の種類 ${dbgIn.pr.size} 最後とずれ ${last ? Math.hypot(last.clientX - e.clientX, last.clientY - e.clientY).toFixed(2) : '-'}\n整数の位置(先頭/途中/最後) ${dbgIn.at.join('/')} 使わなかった点 ${dbgIn.skipped}`;
  if (dbgIn.frames % 10 === 0) debugCount(null);
}

// ペンが途切れて再開したときの間隔(時間・距離・つないだか)
const debugGaps = [];
function debugGap(how, dt, dist, ok) {
  debugGaps.unshift(`${how} ${Math.round(dt)}ms ${Math.round(dist)}px ${ok ? 'つないだ' : '別の線'}`);
  debugGaps.length = Math.min(debugGaps.length, 8);
  debugCount(ok ? 'joined' : 'notjoined');
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
      if (!int) a.frac = true;
      else if (a.pen && (a.frac || evs.some((x) => !Number.isInteger(x.clientX)))) { if (debugOn) dbgIn.skipped++; continue; }
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
  if (e.pointerType === 'pen' && !a.shaped && a.d.pts.length) {
    const [x, y] = a.lastXY || [e.clientX, e.clientY];
    const how = e.type === 'pointercancel' ? 'cancel' : 'up';
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
  S.sel = null;
  document.querySelectorAll('.sel-box').forEach((el) => el.remove());
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
  if (entry.relayout) renderPages();
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

// after: このページの後ろに入れる。tpl/size を省くと今のページと同じにする
async function addPage(after = currentPage(), tpl, sizeId) {
  const pages = pagesOf(S.note);
  after = after || pages[pages.length - 1];
  const i = pages.indexOf(after);
  const next = pages[i + 1];
  const order = after ? (next ? (after.order + next.order) / 2 : after.order + 1) : 1;
  const cbg = after && bgOf(after);
  const ruling = tpl || (cbg && cbg.type === 'blank' ? cbg.ruling : 'lines-b');
  let w = PAGE_A4.w, h = PAGE_A4.h;
  if (sizeId) ({ w, h } = sizeById(sizeId));
  else if (after && cbg?.type === 'blank') ({ w, h } = after);
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
  if (!confirm('このページを削除しますか?(「元に戻す」で復元できます)')) return;
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

// ---------- ページ一覧(並べ替え・テンプレート) ----------
function bindPagesPanel() {
  $('#pages-close').onclick = () => $('#pages-dialog').close();
  $('#pp-add').onclick = async () => {
    const pages = pagesOf(S.note);
    await addPage(pages[pages.length - 1], $('#pp-tpl').value, $('#pp-size').value);
    renderPagesPanel();
  };
}

function openPagesPanel() {
  renderPagesPanel();
  $('#pages-dialog').showModal();
}

function renderPagesPanel() {
  const list = $('#pp-list');
  list.innerHTML = '';
  const pages = pagesOf(S.note);
  pages.forEach((pg, i) => {
    const row = document.createElement('div');
    row.className = 'pp-row';
    const bg = bgOf(pg);
    const tplSel = bg && bg.type === 'blank'
      ? `<select class="pp-tpl" title="テンプレート">${TEMPLATES.map((t) => `<option value="${t.id}"${(bg.ruling === 'lines' ? 'lines-b' : bg.ruling) === t.id ? ' selected' : ''}>${t.label}</option>`).join('')}</select>`
      : '<span class="pp-note">PDF</span>';
    row.innerHTML = `<canvas class="pp-thumb"></canvas>
      <div class="pp-info"><b>${i + 1}</b>${tplSel}</div>
      <div class="pp-btns">
        <button data-a="up" title="前へ" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-a="down" title="後ろへ" ${i === pages.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-a="go">表示</button>
        <button data-a="del" class="danger">削除</button>
      </div>`;
    list.appendChild(row);
    drawThumb(row.querySelector('canvas'), pg);
    row.querySelector('[data-a=up]').onclick = () => movePage(pg, pages[i - 2], pages[i - 1]);
    row.querySelector('[data-a=down]').onclick = () => movePage(pg, pages[i + 1], pages[i + 2]);
    row.querySelector('[data-a=go]').onclick = () => { $('#pages-dialog').close(); S.views.get(pg.id)?.el.scrollIntoView({ block: 'start' }); };
    row.querySelector('[data-a=del]').onclick = async () => { await deletePage(pg.id); renderPagesPanel(); };
    const ts = row.querySelector('.pp-tpl');
    if (ts) ts.onchange = async () => {
      const before = bgOf(pg);
      const nb = { type: 'blank', ruling: ts.value };
      await commit([mk('page.bg', { pageId: pg.id, bg: nb })]);
      pushUndo({ undo: [['page.bg', { pageId: pg.id, bg: before }]], redo: [['page.bg', { pageId: pg.id, bg: nb }]], relayout: true });
      renderPages();
      renderPagesPanel();
    };
  });
}

// pg を a と b の間に動かす
async function movePage(pg, a, b) {
  const order = a && b ? (a.order + b.order) / 2 : a ? a.order + 1 : b ? b.order - 1 : 0;
  const before = pg.order;
  await commit([mk('page.move', { pageId: pg.id, order })]);
  pushUndo({ undo: [['page.move', { pageId: pg.id, order: before }]], redo: [['page.move', { pageId: pg.id, order }]], relayout: true });
  renderPages();
  renderPagesPanel();
}

function drawThumb(canvas, pg) {
  const W = 84;
  canvas.width = W * 2;
  canvas.height = Math.round((W * 2 * pg.h) / pg.w);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const bg = bgOf(pg);
  const draw = () => {
    const c2 = scaledCtx(canvas, pg);
    if (bg?.type === 'blank') paintTemplate(c2, bg, pg.w, pg.h);
    for (const e of strokesOf(S.note, pg.id)) drawStroke(c2, styleOf(e), e.off, geoOf(e));
  };
  if (bg?.type === 'pdf') renderPdfPage(canvas, bg.hash, bg.page).then(draw).catch(draw);
  else draw();
}

init().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<p style="padding:24px">起動できませんでした: ${esc(e.message)}</p>`;
});
