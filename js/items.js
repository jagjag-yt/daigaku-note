// 画像とテキストボックス(ここでは「部品」と呼ぶ)。いまは GoodNotes から取り込んだものだけが対象。
//
// 部品は item.add の op で足し(中身は線と同じ形)、tool が 'image' / 'text' のものを部品として扱う。
// pts には四隅 (x, y, 0) を入れておくので、投げ縄での選択・移動・複製・削除・元に戻す・ページの複製は
// 線と同じ仕組み(stroke.tf / stroke.del など)のまま動く。部品を知らない古い版のアプリは item.add を無視する。
//   画像:          { tool: 'image', hash, mime, pts, width: 0, color }
//   テキストボックス・付箋: { tool: 'text', text, size, font, color, fill, border: { w, color }, radius,
//                         pad(左右の余白), padT(上の余白), wrap(幅で折り返すか), foot(付箋の下の小さな文字), pts, width: 0 }
import * as db from './db.js';

export const isItem = (d) => !!d && (d.tool === 'image' || d.tool === 'text');

export function cornerPts(x, y, w, h) {
  const r = (v) => Math.round(v * 100) / 100;
  return [r(x), r(y), 0, r(x + w), r(y), 0, r(x + w), r(y + h), 0, r(x), r(y + h), 0];
}

// 部品の位置と大きさ(移動のずれ off を足したもの)
export function itemRect(d, off = [0, 0]) {
  const p = d.pts;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
  }
  return { x: x0 + off[0], y: y0 + off[1], w: x1 - x0, h: y1 - y0 };
}

// ---------- テキストの組み方 ----------
// 画面(SVG)・サムネイル(キャンバス)・PDF(キャンバスで画像にする)のどれも同じ折り返しになるよう、
// キャンバスで文字の幅を測って行に分ける。
export const FONT_STACK = "'Helvetica Neue', Helvetica, Arial, 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', 'Yu Gothic', Meiryo, sans-serif";
const LINE = 1.25; // 行の高さ(文字の大きさに対する倍率)
const ASCENT = 0.92; // 行の上端から文字の基準線まで

const fontFamily = (d) => (d.font && !/^\s*$/.test(d.font) ? `'${d.font.replace(/['"\\]/g, '')}', ` : '') + FONT_STACK;
const fontOf = (d) => `${d.size}px ${fontFamily(d)}`;

let measureCtx = null;
function measurer() {
  if (!measureCtx) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    measureCtx = c.getContext('2d');
  }
  return measureCtx;
}

// 組んだ結果を覚えておく(色を変えた部品は描くたびに別のオブジェクトになるので、中身で引く)
const layoutCache = new Map();
// 行の配列 [{ s: 文字列, y: 基準線の y(部品の上端から) }]
export function textLayout(d) {
  const r0 = itemRect(d);
  const key = JSON.stringify([d.text, d.size, d.font, d.pad, d.padT, d.wrap, r0.w]);
  const cached = layoutCache.get(key);
  if (cached) return cached;
  const ctx = measurer();
  ctx.font = fontOf(d);
  const maxW = d.wrap === false ? Infinity : Math.max(d.size, itemRect(d).w - d.pad * 2);
  const top = d.padT ?? d.pad;
  const lines = [];
  for (const para of String(d.text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!para) { lines.push(''); continue; }
    let line = '';
    for (const ch of para) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxW) {
        // 英語などは単語の途中で切らない(行の中に空白があれば、そこで折り返す)
        const sp = /\S/.test(ch) ? line.lastIndexOf(' ') : -1;
        if (sp > 0 && /[\x21-\x7e]$/.test(line)) {
          lines.push(line.slice(0, sp));
          line = line.slice(sp + 1) + ch;
        } else {
          lines.push(line);
          line = ch === ' ' ? '' : ch;
        }
      } else line = next;
    }
    lines.push(line);
  }
  const out = lines.map((s, i) => ({ s, y: top + d.size * (ASCENT + i * LINE) }));
  if (layoutCache.size > 2000) layoutCache.clear();
  layoutCache.set(key, out);
  return out;
}

// 付箋の左下に小さく出す名前
function footOf(d, r) {
  return { size: 8, color: '#4b5563', x: r.x + d.pad, y: r.y + r.h - Math.max(6, d.padT ?? d.pad) };
}

// ---------- 画像の読み込み ----------
// 画像のデータは IndexedDB に入っているので、読み終わるまでは灰色の枠を出し、読めたら描き直してもらう
const urls = new Map(); // hash → object URL(読み込み中は Promise)
const decoded = new Map(); // hash → 読み込み済みの HTMLImageElement(キャンバス用。読み込み中は 'loading')
let listener = () => {};
export function onImageReady(fn) { listener = fn; }
// 読み終わった知らせはまとめて1回にする(画像の多いページで、何度も描き直さないように)
let readyHashes = new Set(), readyTimer = 0;
function readyListener(hash) {
  readyHashes.add(hash);
  if (readyTimer) return;
  readyTimer = setTimeout(() => {
    const hs = readyHashes;
    readyHashes = new Set();
    readyTimer = 0;
    listener(hs);
  }, 50);
}

// ノートを閉じたら、読み込んだ画像を手放す(写真の多いノートを続けて開いてもメモリが増え続けないように)
let gen = 0;
export function releaseImages() {
  gen++;
  for (const u of urls.values()) if (typeof u === 'string') URL.revokeObjectURL(u);
  urls.clear();
  decoded.clear();
}

export function imageUrl(hash) {
  const u = urls.get(hash);
  if (typeof u === 'string') return u;
  if (!u) {
    const g = gen;
    urls.set(hash, db.getFile(hash).then((f) => {
      if (g !== gen) return; // 読んでいる間にノートが閉じられた
      // まだ同期で届いていないときは覚えずに消しておき、次に描くときにもう一度探す
      if (!f) { urls.delete(hash); return; }
      urls.set(hash, URL.createObjectURL(f.data));
      readyListener(hash);
    }, () => urls.delete(hash)));
  }
  return null;
}

export function imageElement(hash) {
  const im = decoded.get(hash);
  if (im instanceof HTMLImageElement) return im;
  if (im) return null; // 読み込み中
  const url = imageUrl(hash);
  if (!url) return null;
  const img = new Image();
  decoded.set(hash, 'loading');
  img.onload = () => { decoded.set(hash, img); readyListener(hash); };
  img.onerror = () => decoded.delete(hash);
  img.src = url;
  return null;
}

// ---------- SVG(画面) ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => Math.round(v * 100) / 100;

function frameSvg(d, r) {
  let out = '';
  const rx = d.radius ? ` rx="${num(d.radius)}"` : '';
  if (d.fill) out += `<rect x="${num(r.x)}" y="${num(r.y)}" width="${num(r.w)}" height="${num(r.h)}"${rx} fill="${esc(d.fill)}"/>`;
  if (d.border && d.border.w > 0) {
    const h = d.border.w / 2;
    out += `<rect x="${num(r.x + h)}" y="${num(r.y + h)}" width="${num(Math.max(0, r.w - d.border.w))}" height="${num(Math.max(0, r.h - d.border.w))}"${rx} fill="none" stroke="${esc(d.border.color)}" stroke-width="${num(d.border.w)}"/>`;
  }
  return out;
}

export function itemSvg(id, d, off = [0, 0]) {
  const tf = off[0] || off[1] ? ` transform="translate(${off[0]} ${off[1]})"` : '';
  const r = itemRect(d);
  let body = '';
  if (d.tool === 'image') {
    const url = imageUrl(d.hash);
    body = url
      ? `<image href="${esc(url)}" x="${num(r.x)}" y="${num(r.y)}" width="${num(r.w)}" height="${num(r.h)}" preserveAspectRatio="none"/>`
      : `<rect x="${num(r.x)}" y="${num(r.y)}" width="${num(r.w)}" height="${num(r.h)}" fill="#f3f4f6" stroke="#d1d5db" stroke-width="1"/>`;
  } else {
    body = frameSvg(d, r);
    const lines = textLayout(d).filter((l) => l.s);
    if (lines.length) {
      body += `<text font-family="${esc(fontFamily(d))}" font-size="${num(d.size)}" fill="${esc(d.color)}" xml:space="preserve">`
        + lines.map((l) => `<tspan x="${num(r.x + d.pad)}" y="${num(r.y + l.y)}">${esc(l.s)}</tspan>`).join('') + '</text>';
    }
    if (d.foot) {
      const f = footOf(d, r);
      body += `<text font-family="${esc(FONT_STACK)}" font-size="${f.size}" fill="${f.color}" x="${num(f.x)}" y="${num(f.y)}">${esc(d.foot)}</text>`;
    }
  }
  return `<g data-id="${id}" class="item"${tf}>${body}</g>`;
}

// ---------- キャンバス(サムネイル・PDF) ----------
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (r > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  else ctx.rect(x, y, w, h);
}

// 読み込み中の画像は灰色の四角で描く。読み終わると onImageReady で知らせる
export function drawItem(ctx, d, off = [0, 0]) {
  const r = itemRect(d, off);
  ctx.save();
  if (d.tool === 'image') {
    const img = imageElement(d.hash);
    if (img) ctx.drawImage(img, r.x, r.y, r.w, r.h);
    else { ctx.fillStyle = '#f3f4f6'; ctx.fillRect(r.x, r.y, r.w, r.h); }
  } else {
    if (d.fill) { ctx.fillStyle = d.fill; roundRect(ctx, r.x, r.y, r.w, r.h, d.radius || 0); ctx.fill(); }
    if (d.border && d.border.w > 0) {
      const h = d.border.w / 2;
      ctx.strokeStyle = d.border.color;
      ctx.lineWidth = d.border.w;
      roundRect(ctx, r.x + h, r.y + h, Math.max(0, r.w - d.border.w), Math.max(0, r.h - d.border.w), d.radius || 0);
      ctx.stroke();
    }
    ctx.fillStyle = d.color;
    ctx.font = fontOf(d);
    ctx.textBaseline = 'alphabetic';
    for (const l of textLayout(d)) if (l.s) ctx.fillText(l.s, r.x + d.pad, r.y + l.y);
    if (d.foot) {
      const f = footOf(d, r);
      ctx.fillStyle = f.color;
      ctx.font = `${f.size}px ${FONT_STACK}`;
      ctx.fillText(d.foot, f.x, f.y);
    }
  }
  ctx.restore();
}

// テキストボックスを PNG にする(PDF に日本語の字形を埋め込まずに済むように)
export async function textPng(d, scale = 4) {
  const r = itemRect(d);
  const c = document.createElement('canvas');
  // 文字が枠から少しはみ出しても切れないよう、下と右に余白をとる
  const lines = textLayout(d);
  const ctx0 = measurer();
  ctx0.font = fontOf(d);
  const textW = Math.max(0, ...lines.map((l) => ctx0.measureText(l.s).width)) + d.pad * 2;
  const textH = (d.padT ?? d.pad) + lines.length * d.size * LINE + d.pad;
  const extra = d.size / 2;
  c.width = Math.max(1, Math.ceil((Math.max(r.w, textW) + extra) * scale));
  c.height = Math.max(1, Math.ceil((Math.max(r.h, textH) + extra) * scale));
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  drawItem(ctx, d, [-r.x, -r.y]);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: c.width / scale, h: c.height / scale };
}

// 部品が投げ縄の中にあるか: 四隅のうち3つ以上が入っていれば選ぶ
// (大きな画像の上に書いた字だけを囲んだときに、画像まで選ばないように)
export function itemInLasso(e, poly, pointInPolygon) {
  const r = itemRect(e.data, e.off);
  const c = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  return c.filter(([x, y]) => pointInPolygon(x, y, poly)).length >= 3;
}
