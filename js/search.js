// 手書き文字の認識と検索。すべて端末の中で動く(Tesseract.js。言語データも同梱)。
// ページを書き換えると、少し間をおいてからそのページの手書きを認識し直し、
// PDF のページなら PDF の文字も取り出して、検索用に保存する。
// 検索用の文字は端末ごとに作り直せるので、同期はしない。

import * as db from './db.js';
import { buildNote, pagesOf, strokesOf, styleOf, bgOf } from './model.js';
import { drawStroke } from './ink.js';
import { pdfPageText } from './pdf.js';

const VENDOR = new URL('../vendor/tesseract/', import.meta.url).href;
let queue = new Set(); // "noteId/pageId"
let timer = 0, busy = false, worker = null, progress = () => {};

export async function init(opts) {
  progress = opts.onProgress || progress;
  const saved = await db.getMeta('ocrQueue');
  if (saved) for (const k of saved) queue.add(k);
  schedule(3000);
}

export function markDirty(noteId, pageId) {
  queue.add(`${noteId}/${pageId}`);
  db.setMeta('ocrQueue', [...queue]);
  schedule();
}

export async function markNoteDirty(noteId) {
  const note = buildNote(noteId, await db.opsForNote(noteId));
  for (const p of pagesOf(note)) queue.add(`${noteId}/${p.id}`);
  db.setMeta('ocrQueue', [...queue]);
  schedule();
}

function schedule(ms = 5000) {
  clearTimeout(timer);
  timer = setTimeout(run, ms);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('文字認識の部品を読み込めませんでした'));
    document.head.appendChild(s);
  });
}

async function getWorker() {
  if (worker) return worker;
  if (!window.Tesseract) await loadScript(VENDOR + 'tesseract.min.js');
  worker = await window.Tesseract.createWorker(['jpn', 'eng'], 1, {
    workerPath: VENDOR + 'worker.min.js',
    corePath: VENDOR + 'core/',
    langPath: VENDOR + 'lang/',
    gzip: true,
  });
  return worker;
}

// 文字を検索しやすい形にそろえる(全角英数→半角、小文字、空白をまとめる)
export function normalize(s) {
  return (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// 日本語の文字の間に入る余計な空白を消す
function tidyOcr(s) {
  return normalize(s).replace(/(?<=[^\x00-\x7f]) (?=[^\x00-\x7f])/g, '');
}

async function recognizeInk(note, pg) {
  const strokes = strokesOf(note, pg.id).filter((e) => e.data.tool !== 'marker');
  if (!strokes.length) return '';
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of strokes) {
    x0 = Math.min(x0, e.bbox.x0 + e.off[0]); y0 = Math.min(y0, e.bbox.y0 + e.off[1]);
    x1 = Math.max(x1, e.bbox.x1 + e.off[0]); y1 = Math.max(y1, e.bbox.y1 + e.off[1]);
  }
  const pad = 12, scale = 2;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round((x1 - x0) * scale));
  c.height = Math.max(1, Math.round((y1 - y0) * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
  for (const e of strokes) drawStroke(ctx, { ...styleOf(e), color: '#000' }, e.off);
  const w = await getWorker();
  const { data } = await w.recognize(c);
  return tidyOcr(data.text);
}

async function run() {
  if (busy || !queue.size) return;
  busy = true;
  const notes = new Map();
  try {
    while (queue.size) {
      const key = queue.values().next().value;
      const [noteId, pageId] = key.split('/');
      progress(`手書き文字を認識しています(残り${queue.size}ページ)`);
      let note = notes.get(noteId);
      if (!note) notes.set(noteId, (note = buildNote(noteId, await db.opsForNote(noteId))));
      const pg = note.pages.get(pageId);
      if (pg && pg.alive) {
        const prev = (await db.getSearch(key)) || {};
        const bg = bgOf(pg);
        let pdf = prev.pdf || '';
        if (bg && bg.type === 'pdf' && prev.pdfSrc !== `${bg.hash}#${bg.page}`) {
          pdf = normalize(await pdfPageText(bg.hash, bg.page).catch(() => ''));
        }
        let ink = '';
        try {
          ink = await recognizeInk(note, pg);
        } catch (e) {
          console.warn('文字認識に失敗しました', e);
          ink = prev.ink || '';
        }
        await db.putSearch({ key, noteId, pageId, ink, pdf, pdfSrc: bg && bg.type === 'pdf' ? `${bg.hash}#${bg.page}` : '', at: Date.now() });
      }
      queue.delete(key);
      await db.setMeta('ocrQueue', [...queue]);
    }
    progress('');
  } catch (e) {
    console.error(e);
    progress('文字認識を中断しました: ' + e.message);
  } finally {
    busy = false;
  }
}

// 空白の有無を無視して探す正規表現
function pattern(q) {
  const chars = [...normalize(q).replace(/\s+/g, '')];
  return new RegExp(chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'i');
}

function snippet(text, re) {
  const m = re.exec(text);
  if (!m) return '';
  const s = Math.max(0, m.index - 30), e = Math.min(text.length, m.index + m[0].length + 30);
  const esc = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return (s ? '…' : '') + esc(text.slice(s, m.index)) + '<mark>' + esc(m[0]) + '</mark>' + esc(text.slice(m.index + m[0].length, e)) + (e < text.length ? '…' : '');
}

// liveNotes: Map(noteId -> note の概要)
export async function query(q, liveNotes) {
  const re = pattern(q);
  const hits = [];
  for (const n of liveNotes.values()) {
    if (re.test(normalize(n.title))) hits.push({ noteId: n.id, title: n.title, snippet: snippet(n.title, re), source: 'ノートの名前' });
  }
  const recs = (await db.allSearch()).filter((r) => liveNotes.has(r.noteId) && (re.test(r.ink) || re.test(r.pdf)));
  const byNote = new Map();
  for (const r of recs) {
    if (!byNote.has(r.noteId)) byNote.set(r.noteId, []);
    byNote.get(r.noteId).push(r);
  }
  for (const [noteId, rs] of byNote) {
    const note = buildNote(noteId, await db.opsForNote(noteId));
    const order = pagesOf(note).map((p) => p.id);
    for (const r of rs) {
      const idx = order.indexOf(r.pageId);
      if (idx < 0) continue;
      const inInk = re.test(r.ink);
      hits.push({ noteId, pageId: r.pageId, pageNo: idx + 1, title: note.title, snippet: snippet(inInk ? r.ink : r.pdf, re), source: inInk ? '手書き' : 'PDFの文字' });
    }
  }
  return hits;
}

