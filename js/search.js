// 検索。ノートの名前と、PDF のページの文字を探す。
// PDF の文字はページが増えたときに取り出して保存しておく(端末ごとに作り直せるので同期はしない)。
// 手書き文字の認識は今は行わない(将来、自動入力や数式の変換を作るときに別の方法で入れる予定)。

import * as db from './db.js';
import { buildNote, pagesOf, bgOf } from './model.js';
import { pdfPageText } from './pdf.js';

let queue = new Set(); // "noteId/pageId"
let timer = 0, busy = false, progress = () => {};

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

// 文字を検索しやすい形にそろえる(全角英数→半角、小文字、空白をまとめる)
export function normalize(s) {
  return (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function run() {
  if (busy || !queue.size) return;
  busy = true;
  const notes = new Map();
  try {
    while (queue.size) {
      const key = queue.values().next().value;
      const [noteId, pageId] = key.split('/');
      progress(`検索の準備をしています(残り${queue.size}ページ)`);
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
        await db.putSearch({ key, noteId, pageId, pdf, pdfSrc: bg && bg.type === 'pdf' ? `${bg.hash}#${bg.page}` : '', at: Date.now() });
      }
      queue.delete(key);
      await db.setMeta('ocrQueue', [...queue]);
    }
    progress('');
  } catch (e) {
    console.error(e);
    progress('検索の準備を中断しました: ' + e.message);
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
  const recs = (await db.allSearch()).filter((r) => liveNotes.has(r.noteId) && re.test(r.pdf || ''));
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
      hits.push({ noteId, pageId: r.pageId, pageNo: idx + 1, title: note.title, snippet: snippet(r.pdf, re), source: 'PDFの文字' });
    }
  }
  return hits;
}

