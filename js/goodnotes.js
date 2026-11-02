// GoodNotes のノート(.goodnotes)の取り込み。
//
// .goodnotes は ZIP。中身は「長さ付き protobuf レコード」を並べたファイル群:
//   index.events.pb … 文書の名前、ページ(並び順・用紙)、用紙(添付PDFと大きさ)などの変更記録
//   notes/<ID>      … ページごとの手書き。線の座標は Apple の LZ4 形式(bv41)で圧縮されている
//   attachments/<ID>… 用紙や読み込んだ PDF・画像そのもの
// 公式の仕様は公開されていないので、実際のファイルを調べて分かった範囲で読む。
// 分からない部分(画像・テキストボックス・ペンの種類ごとの太さなど)は取り込まない。

import * as db from './db.js';
import { newId } from './model.js';
import { sha256 } from './pdf.js';

// ---------- ZIP ----------
async function unzip(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 形式ではありません');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nlen));
    p += 46 + nlen + xlen + clen;
    const lnl = dv.getUint16(local + 26, true), lxl = dv.getUint16(local + 28, true);
    const start = local + 30 + lnl + lxl;
    files.set(name, { method, data: new Uint8Array(buf, start, csize) });
  }
  return {
    has: (n) => files.has(n),
    names: () => [...files.keys()],
    async get(n) {
      const f = files.get(n);
      if (!f) return null;
      if (f.method === 0) return f.data;
      if (f.method !== 8) throw new Error('対応していない圧縮形式です');
      const ds = new DecompressionStream('deflate-raw');
      const out = new Response(new Blob([f.data]).stream().pipeThrough(ds));
      return new Uint8Array(await out.arrayBuffer());
    },
  };
}

// ---------- protobuf(型情報なしで読む) ----------
function varint(b, st) {
  let r = 0, mul = 1, c;
  do {
    c = b[st.i++];
    r += (c & 0x7f) * mul;
    mul *= 128;
  } while (c & 0x80);
  return r;
}

// フィールド番号 → 値の配列
function pb(b) {
  const out = new Map();
  const st = { i: 0 };
  while (st.i < b.length) {
    const key = varint(b, st);
    const f = Math.floor(key / 8), w = key & 7;
    let v;
    if (w === 0) v = varint(b, st);
    else if (w === 1) { v = b.subarray(st.i, st.i + 8); st.i += 8; }
    else if (w === 5) { v = new DataView(b.buffer, b.byteOffset + st.i, 4).getFloat32(0, true); st.i += 4; }
    else if (w === 2) { const l = varint(b, st); v = b.subarray(st.i, st.i + l); st.i += l; }
    else throw new Error('protobuf を読めませんでした');
    if (!out.has(f)) out.set(f, []);
    out.get(f).push(v);
  }
  return out;
}
const one = (m, f) => m.get(f)?.[0];
const str = (v) => (v ? new TextDecoder().decode(v) : '');

function* records(b) {
  const st = { i: 0 };
  while (st.i < b.length) {
    const l = varint(b, st);
    yield b.subarray(st.i, st.i + l);
    st.i += l;
  }
}

// ---------- Apple LZ4(bv41) ----------
function lz4block(src, out) {
  let i = 0;
  while (i < src.length) {
    const tok = src[i++];
    let ll = tok >> 4;
    if (ll === 15) { let b; do { b = src[i++]; ll += b; } while (b === 255); }
    for (let k = 0; k < ll; k++) out.push(src[i + k]);
    i += ll;
    if (i >= src.length) break;
    const off = src[i] | (src[i + 1] << 8);
    i += 2;
    let ml = tok & 15;
    if (ml === 15) { let b; do { b = src[i++]; ml += b; } while (b === 255); }
    ml += 4;
    const s = out.length - off;
    for (let k = 0; k < ml; k++) out.push(out[s + k]);
  }
}
function bv41(b) {
  const out = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  while (i + 4 <= b.length) {
    const m = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    if (m === 'bv4$') break;
    if (m === 'bv41') {
      const cl = dv.getUint32(i + 8, true);
      lz4block(b.subarray(i + 12, i + 12 + cl), out);
      i += 12 + cl;
    } else if (m === 'bv4-') {
      const dl = dv.getUint32(i + 4, true);
      for (let k = 0; k < dl; k++) out.push(b[i + 8 + k]);
      i += 8 + dl;
    } else throw new Error('線のデータを展開できませんでした');
  }
  return new Uint8Array(out);
}

// 展開した線のデータから、座標 (x, y) の並びを探す。
// 「個数(u32) + float の並び」のうち、ページ内に収まり点どうしが近い、いちばん長いものを使う。
function strokePoints(raw) {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let start = 8;
  while (start < raw.length && raw[start] !== 0) start++;
  start++;
  let best = null;
  for (let p = start; p + 4 <= raw.length; p++) {
    const n = dv.getUint32(p, true);
    if (n < 2 || n % 2 || p + 4 + n * 4 > raw.length || (best && n <= best.length)) continue;
    const fl = new Float32Array(n);
    let ok = true;
    for (let k = 0; k < n; k++) {
      const f = dv.getFloat32(p + 4 + k * 4, true);
      if (!(f > -100 && f < 5000)) { ok = false; break; }
      fl[k] = f;
      if (k % 2 === 1 && k >= 3 && Math.hypot(fl[k - 1] - fl[k - 3], f - fl[k - 2]) > 200) { ok = false; break; }
    }
    if (ok) best = fl;
  }
  return best;
}

// 128 ビットの UUID に 1 を足す(ページID → 手書きファイルのID)
function uuidPlusOne(id) {
  const hex = id.replace(/-/g, '');
  const n = (BigInt('0x' + hex) + 1n).toString(16).toUpperCase().padStart(32, '0');
  return `${n.slice(0, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}-${n.slice(16, 20)}-${n.slice(20)}`;
}

const clockOf = (m) => {
  const c = m && pb(m);
  return c ? (one(c, 1) || 0) : 0;
};

const toHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

export async function importGoodnotes(file, recorder) {
  const zip = await unzip(await file.arrayBuffer());
  if (!zip.has('index.events.pb')) throw new Error('GoodNotes のノートではないようです');

  // 1) 変更記録を読んで、文書名・ページ・用紙を組み立てる
  let title = file.name.replace(/\.goodnotes$/i, '');
  const papers = new Map(); // 用紙ID → { att, page, w, h, tpl }
  const pages = new Map(); // ページID → { paper, paperC, order, orderC }
  for (const rec of records(await zip.get('index.events.pb'))) {
    const top = pb(rec);
    for (const [f, vals] of top) {
      if (f === 1) continue;
      let body;
      try { body = pb(vals[0]); } catch { continue; }
      if (f === 30) {
        const t = one(body, 2);
        if (t) { const tt = str(one(pb(t), 1)); if (tt) title = tt; }
      } else if (f === 2) {
        const size = one(body, 8) && pb(one(body, 8));
        papers.set(str(one(body, 2)), {
          att: str(one(body, 4)), page: one(body, 5) || 1,
          w: size ? one(size, 1) : 834.24, h: size ? one(size, 2) : 1078.82, tpl: str(one(body, 9)),
        });
      } else if (f === 54 || f === 3) {
        const id = str(one(body, 2));
        const pg = pages.get(id) || { paper: null, paperC: -1, order: '', orderC: -1 };
        const pr = one(body, 3) && pb(one(body, 3));
        if (pr) {
          const c = clockOf(one(pr, 2));
          if (c >= pg.paperC) { pg.paper = str(one(pr, 1)); pg.paperC = c; }
        }
        const or = one(body, 4) && pb(one(body, 4));
        if (or) {
          const c = clockOf(one(or, 2));
          if (c >= pg.orderC) { pg.order = str(one(or, 1)); pg.orderC = c; }
        }
        pages.set(id, pg);
      }
    }
  }
  const pageList = [...pages.entries()].filter(([, p]) => p.paper).sort((a, b) => (a[1].order < b[1].order ? -1 : a[1].order > b[1].order ? 1 : 0));
  if (!pageList.length) throw new Error('ページが見つかりませんでした');

  // 2) 用紙の PDF(白紙のテンプレート以外)を保存する
  const pdfHash = new Map();
  for (const paper of papers.values()) {
    if (pdfHash.has(paper.att)) continue;
    const data = await zip.get('attachments/' + paper.att);
    if (!data || data.length < 4 || String.fromCharCode(...data.subarray(0, 4)) !== '%PDF') continue;
    // GoodNotes の白紙テンプレートは中身のない小さな PDF なので、無地のページとして扱う
    if (data.length < 4096 && /White/i.test(paper.tpl)) { pdfHash.set(paper.att, null); continue; }
    const hash = await sha256(data);
    if (!(await db.hasFile(hash))) await db.putFile({ hash, name: title + '.pdf', type: 'application/pdf', data: new Blob([data], { type: 'application/pdf' }) });
    pdfHash.set(paper.att, hash);
  }

  // 3) 大学ノートの変更記録として書き込む
  const noteId = newId();
  const ops = [recorder.make(noteId, 'note.create', { title })];
  const pageIds = [];
  let strokes = 0;
  for (let i = 0; i < pageList.length; i++) {
    const [gid, pg] = pageList[i];
    const paper = papers.get(pg.paper) || { w: 834.24, h: 1078.82 };
    const hash = pdfHash.get(paper.att);
    const pageId = newId();
    pageIds.push(pageId);
    const bg = hash ? { type: 'pdf', hash, page: paper.page } : { type: 'blank', ruling: 'none' };
    ops.push(recorder.make(noteId, 'page.add', { page: { id: pageId, w: paper.w, h: paper.h, order: i + 1, bg } }));

    const notesName = 'notes/' + uuidPlusOne(gid);
    const data = (await zip.get(notesName)) || (await zip.get('notes/' + gid));
    if (!data) continue;
    // 消された線: 見出しレコードのフィールド3が1で、時計がいちばん新しいもの
    const head = new Map(); // 線ID → { c, del }
    const bodies = [];
    for (const rec of records(data)) {
      let m;
      try { m = pb(rec); } catch { continue; }
      if (m.has(7)) bodies.push(m.get(7)[0]);
      else if (m.has(1) && m.has(2)) {
        const id = str(one(m, 1));
        const c = clockOf(one(m, 2));
        const cur = head.get(id);
        if (!cur || c >= cur.c) head.set(id, { c, del: one(m, 3) === 1 });
      }
    }
    for (const b of bodies) {
      let m;
      try { m = pb(b); } catch { continue; }
      const id = str(one(m, 1));
      if (head.get(id)?.del) continue;
      const blob = one(m, 2);
      if (!blob || blob.length < 4 || blob[0] !== 0x62) continue; // 'bv41'
      let pts;
      try { pts = strokePoints(bv41(blob)); } catch { continue; }
      if (!pts) continue;
      const col = one(m, 4) ? pb(one(m, 4)) : null;
      const [r, g, bb, a] = col ? [one(col, 1) ?? 0, one(col, 2) ?? 0, one(col, 3) ?? 0, one(col, 4) ?? 1] : [0, 0, 0, 1];
      const marker = a < 0.9;
      const flat = [];
      for (let k = 0; k < pts.length; k += 2) flat.push(Math.round(pts[k] * 10) / 10, Math.round(pts[k + 1] * 10) / 10, 0.5);
      ops.push(recorder.make(noteId, 'stroke.add', {
        s: { id: newId(), pageId, tool: marker ? 'marker' : 'pen', color: toHex(r, g, bb), width: marker ? 12 : 1.6, pr: false, pts: flat, src: 'goodnotes' },
      }));
      strokes++;
    }
  }
  await db.putOps(ops, recorder.clock);
  return { noteId, title, pages: pageList.length, strokes, pageIds };
}
