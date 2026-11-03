// GoodNotes のノート(.goodnotes)の取り込み。
//
// .goodnotes は ZIP。中身は「長さ付き protobuf レコード」を並べたファイル群:
//   index.events.pb … 文書の名前、ページ(並び順・用紙)、用紙(添付PDFと大きさ)などの変更記録
//   notes/<ID>      … ページごとの手書き。線の座標は Apple の LZ4 形式(bv41)で圧縮されている
//   attachments/<ID>… 用紙や読み込んだ PDF・画像そのもの
// notes/ のレコードは、いちばん外側のフィールド番号で種類が分かる(7 = 線、1 = 画像、20 = 付箋、21 = テキストボックス)。
// 公式の仕様は公開されていないので、実際のファイルを調べて分かった範囲で読む。
// 分からない部分(鉛筆などの質感、画像の回転・切り抜きなど)は取り込まない。

import * as db from './db.js';
import { newId } from './model.js';
import { sha256 } from './pdf.js';
import { cornerPts } from './items.js';

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

// ---------- 線のデータ(tpl 形式) ----------
// 展開した線のデータは「tpl\0 + 全体の長さ(u32) + 型の文字列 + \0 + 値」。型の文字列は
//   v = 2バイトの整数、u = 4バイト(float)、f = float、A(…) = 個数(u32)+並び、S(…) = 組
// で、たとえば万年筆は "vA(v)A(u)A(u)…"、蛍光ペンは "vuA(v)A(S(uu))A(S(uuuu))vA(f)"。
function tplSig(s, i = 0) {
  const out = [];
  while (i < s.length) {
    const c = s[i];
    if (c === 'v' || c === 'u' || c === 'f') { out.push(c); i++; }
    else if ((c === 'A' || c === 'S') && s[i + 1] === '(') {
      const [inner, j] = tplSig(s, i + 2);
      out.push({ k: c, inner });
      i = j;
    } else if (c === ')') return [out, i + 1];
    else throw new Error('tpl');
  }
  return [out, i];
}
// 値を読む。u と f は float、S(…) はそのまま中身を平らに並べる
function tplRead(t, dv, st, flat) {
  if (t === 'v') { const v = dv.getUint16(st.i, true); st.i += 2; flat.push(v); return; }
  if (t === 'u' || t === 'f') { const v = dv.getFloat32(st.i, true); st.i += 4; flat.push(v); return; }
  if (t.k === 'S') { for (const x of t.inner) tplRead(x, dv, st, flat); return; }
  const n = dv.getUint32(st.i, true);
  st.i += 4;
  if (n > 5e6) throw new Error('tpl');
  for (let k = 0; k < n; k++) for (const x of t.inner) tplRead(x, dv, st, flat);
}
// 型の文字列に戻す(並びの形を比べるため)
const sigOf = (t) => (typeof t === 'string' ? t : `${t.k}(${t.inner.map(sigOf).join('')})`);
function parseTpl(raw) {
  if (raw.length < 9 || String.fromCharCode(raw[0], raw[1], raw[2]) !== 'tpl') return null;
  let e = 8;
  while (e < raw.length && raw[e] !== 0) e++;
  const sig = String.fromCharCode(...raw.subarray(8, e));
  const [types] = tplSig(sig);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const st = { i: e + 1 };
  const vals = types.map((t) => {
    const flat = [];
    tplRead(t, dv, st, flat);
    return t.k === 'A' ? flat : flat.length === 1 ? flat[0] : flat;
  });
  return { sig, top: types.map(sigOf), vals };
}

// 2次ベジェ曲線 a → c → b を細かい点にする。点は [x, y, 太さ]
function quadTo(out, a, c, b) {
  const len = Math.hypot(c[0] - a[0], c[1] - a[1]) + Math.hypot(b[0] - c[0], b[1] - c[1]);
  const n = Math.max(1, Math.min(24, Math.ceil(len / 1.5)));
  for (let k = 1; k <= n; k++) {
    const t = k / n, u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1], u * a[2] + t * b[2]]);
  }
}
// 始点と「制御点・終点」の並びから中心線を作る。stride = 1区間の値の数、ctrl/end = 区間の中で x の位置、wOf = 太さの読み方
function bezierLine(start, segs, stride, ctrl, end, wOf) {
  if (!start || start.length < 2 || !stride || segs.length % stride) return null;
  const line = [[start[0], start[1], wOf(start, 0)]];
  for (let i = 0; i < segs.length; i += stride) {
    const c = [segs[i + ctrl], segs[i + ctrl + 1], wOf(segs, i + ctrl)];
    const b = [segs[i + end], segs[i + end + 1], wOf(segs, i + end)];
    quadTo(line, line[line.length - 1], c, b);
  }
  return line;
}

// 図形はペンの点ではなく、形そのものが記録されている。15 = 太さ
//   9.1 = 折れ線 {1: 点, 1: 点, …}、9.2 = 曲線 {1:始点, 2:制御点, 3:終点}、
//   9.3 = 四角 {1:中心, 2:{幅,高さ}, 3:回転(推測)}、9.4 = 楕円 {1:中心, 2:{横の半径,縦の半径}, 3:回転(ラジアン)}
// 知らない形は推測でつながず、取り込まない
function shapeLine(sh) {
  const w = fin(one(sh, 15), 1.6);
  const P = (m, f) => xy(sub(m, f));
  const rot = (cx, cy, a) => (q) => {
    if (!a) return q;
    const c = Math.cos(a), s = Math.sin(a), dx = q[0] - cx, dy = q[1] - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  };
  let line = null;
  const poly = sub(sh, 1), curve = sub(sh, 2), rect = sub(sh, 3), ell = sub(sh, 4);
  if (rect && P(rect, 1) && P(rect, 2)) {
    const [cx, cy] = P(rect, 1), [rw, rh] = P(rect, 2);
    const x0 = cx - rw / 2, y0 = cy - rh / 2, x1 = cx + rw / 2, y1 = cy + rh / 2;
    line = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(rot(cx, cy, fin(one(rect, 3))));
  } else if (ell && P(ell, 1) && P(ell, 2)) {
    const [cx, cy] = P(ell, 1), [rx, ry] = P(ell, 2);
    const n = Math.max(24, Math.min(96, Math.ceil((Math.abs(rx) + Math.abs(ry)) * 1.5)));
    line = [];
    for (let k = 0; k <= n; k++) {
      const t = (k / n) * Math.PI * 2;
      line.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
    }
    line = line.map(rot(cx, cy, fin(one(ell, 3))));
  } else if (curve && P(curve, 1) && P(curve, 2) && P(curve, 3)) {
    const a = [...P(curve, 1), w], c = [...P(curve, 2), w], b = [...P(curve, 3), w];
    line = [a];
    quadTo(line, a, c, b);
  } else if (poly) {
    line = (poly.get(1) || []).map((v) => { try { return v instanceof Uint8Array ? xy(pb(v)) : null; } catch { return null; } }).filter(Boolean);
    if (line.length < 2) line = null;
  }
  if (line && !line.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]))) line = null;
  return line && { line: line.map((q) => [q[0], q[1], w]), width: w, shape: true };
}

// 線のデータから中心線と太さを読む。{ line: [[x, y, 太さ], …], width, shape } / 点のない線は { empty: true }
// 並びの形(型の文字列)で種類を見分ける。先頭に値(版数・太さ・ペンの設定など)がいくつか付くので、
// 「A(v) = 区間の種類」から始まる3つの並びの位置を探して、そこから読む。
//   ふつうのペン "vA(v)A(u)A(u)…": 始点 (x,y,半径[,…])、区間 (制御点 x,y,半径, 終点 x,y,半径[, …])。
//     ペン種別4は先頭に値が1つ多い。新しめの線は始点が4つ・区間が9つの値
//   鉛筆 "vuA(v)A(S(uuuuu))A(S(11個))…": u=太さ、始点 (x,y,方位角,傾き,筆圧)、区間 (ID, 制御点5個, 終点5個)
//   蛍光ペンなど "vuA(v)A(S(uu))A(S(uuuu))…": u=太さ、始点 (x,y)、区間 (制御点 x,y, 終点 x,y)
const PEN = ['A(v)', 'A(u)', 'A(u)'];
const PENCIL = ['A(v)', 'A(S(uuuuu))', 'A(S(uuuuuuuuuuu))'];
const PLAIN = ['A(v)', 'A(S(uu))', 'A(S(uuuu))'];
// 先頭の値(v・u・f)が最大2つ続いたあとに、form の並びがあればその位置
function findForm(top, form) {
  for (let k = 0; k <= 2 && k + form.length <= top.length; k++) {
    if (k && !['v', 'u', 'f'].includes(top[k - 1])) return -1;
    if (form.every((f, j) => top[k + j] === f)) return k;
  }
  return -1;
}
// 並びのすぐ前の u(太さ)。なければ 0
const widthBefore = (t, k) => (k > 0 && t.top[k - 1] === 'u' && Number.isFinite(t.vals[k - 1]) ? t.vals[k - 1] : 0);
function strokeLine(raw) {
  const t = parseTpl(raw);
  if (!t) return null;
  const v = t.vals;
  let line = null, width = 0, k;
  if ((k = findForm(t.top, PEN)) >= 0) {
    const cmds = v[k], start = v[k + 1], segs = v[k + 2];
    if (!cmds.length && !start.length) return { empty: true };
    const nseg = cmds.length - 1;
    if (nseg > 0 && segs.length % nseg === 0 && segs.length / nseg >= 6) {
      line = bezierLine(start, segs, segs.length / nseg, 0, 3, (a, i) => a[i + 2] * 2);
    } else if (nseg === 0 && start.length >= 3) line = [[start[0], start[1], start[2] * 2]];
  } else if ((k = findForm(t.top, PENCIL)) >= 0) {
    // 筆圧(0〜1)を太さに焼き込む。筆圧1でちょうど基本の太さ、弱いと細く(最小で 0.3 倍)
    const base = widthBefore(t, k);
    if (!v[k + 1].length) return { empty: true };
    if (!(base > 0)) return null;
    const wOf = (a, i) => base * (0.3 + 0.7 * Math.max(0, Math.min(1, fin(a[i + 4], 1))));
    line = bezierLine(v[k + 1].slice(0, 5), v[k + 2], 11, 1, 6, wOf);
  } else if ((k = findForm(t.top, PLAIN)) >= 0) {
    width = widthBefore(t, k);
    if (!v[k + 1].length) return { empty: true };
    const w = () => width;
    line = bezierLine(v[k + 1].slice(0, 2), v[k + 2], 4, 0, 2, w);
  } else return null;
  if (!line || !line.length || !line.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]) && Number.isFinite(q[2]))) return null;
  return { line, width };
}

// 白紙の PDF か: 描く命令が「白で塗る」だけ(GoodNotes の白紙は、白い四角を塗るか、何も描かない)。
// 罫線などの色のある塗り・線・文字・画像があれば白紙ではない。判断できないときも白紙ではないことにする
const PAINT = new Set(['f', 'F', 'f*']);
// 線・塗りと線・文字(BT から始まる)・画像・グラデーション
const MARK = new Set(['S', 's', 'B', 'B*', 'b', 'b*', 'BT', 'Tj', 'TJ', "'", '"', 'Do', 'sh', 'BI', 'EI']);
async function isBlankPdf(data) {
  const text = new TextDecoder('latin1').decode(data);
  const re = /(?:^|[^d])stream\r?\n/g; // 「endstream」の中の stream には当てない
  let m, streams = 0;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) return false;
    let stop = end;
    while (stop > start && (data[stop - 1] === 0x0a || data[stop - 1] === 0x0d)) stop--;
    let body = data.subarray(start, stop);
    const dictAll = text.slice(Math.max(0, m.index - 400), m.index);
    const dict = dictAll.slice(dictAll.lastIndexOf('<<'));
    if (/\/Subtype\s*\/Image|\/N\s+[134]\b|\/Type\s*\/(XRef|ObjStm|Metadata)/.test(dict)) continue; // 画像・色の情報など
    if (/\/Filter/.test(dict)) {
      if (!/FlateDecode/.test(dict) || /\[\s*\//.test(dict.slice(dict.indexOf('/Filter')))) return false;
      try {
        const ds = new DecompressionStream('deflate');
        body = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(ds)).arrayBuffer());
      } catch { return false; }
    }
    streams++;
    let nums = [], white = false;
    const saved = [];
    for (const tok of new TextDecoder('latin1').decode(body).split(/\s+/)) {
      if (!tok) continue;
      if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(tok)) { nums.push(+tok); continue; }
      if (tok === 'q') saved.push(white);
      else if (tok === 'Q') white = saved.length ? saved.pop() : false;
      else if (tok === 'scn' || tok === 'sc' || tok === 'rg' || tok === 'g') white = nums.length > 0 && nums.every((v) => v === 1);
      else if (tok === 'k') white = nums.length === 4 && nums.every((v) => v === 0);
      else if (PAINT.has(tok)) { if (!white) return false; }
      else if (MARK.has(tok)) return false;
      nums = [];
    }
  }
  return streams > 0;
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

const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
const sub = (m, ...path) => {
  for (const f of path) {
    const v = m && one(m, f);
    if (!(v instanceof Uint8Array)) return null;
    try { m = pb(v); } catch { return null; }
  }
  return m;
};
const xy = (m) => (m ? [fin(one(m, 1)), fin(one(m, 2))] : null);
// 色 { 1:R, 2:G, 3:B, 4:A }(0〜1)。0 の成分は記録されない
const rgba = (m) => (m ? [fin(one(m, 1)), fin(one(m, 2)), fin(one(m, 3)), fin(one(m, 4))] : null);

function imageType(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null; // HEIC などはブラウザで表示できないので取り込まない
}

// 画像: { 1:ID, 2:{ 1:{x,y} 左上, 2:{w,h} }, 3:{ 1:{x,y} 中心, 2:{w,h} }, 4:添付ID }
function parseImage(m) {
  const id = str(one(m, 1)), att = str(one(m, 4));
  let pos = xy(sub(m, 2, 1)), size = xy(sub(m, 2, 2));
  if (!size) {
    size = xy(sub(m, 3, 2));
    const c = xy(sub(m, 3, 1));
    if (size && c) pos = [c[0] - size[0] / 2, c[1] - size[1] / 2];
  }
  if (!id || !att || !pos || !size || !(size[0] > 0.5 && size[1] > 0.5)) return null;
  return { id, att, x: pos[0], y: pos[1], w: size[0], h: size[1] };
}

// 書式つきの文字: { 1:{ 2:書式つき文字列(bv41 圧縮) }, 2:{w,h} 文字の大きさ, 5:{ 1:既定の書式 }, 10:{上,左,下,右} 余白 }
// 書式つき文字列は区間の並び { 1:[{ 1:文字, 2:書式 }, …] }。書式 = { 3:色, 30:フォント名, 40:大きさ(-404 は未設定) }
function parseRich(r) {
  const out = { text: '', style: null, def: r ? sub(r, 5, 1) : null, content: r ? xy(sub(r, 2)) : null, inset: null };
  if (!r) return out;
  const ins = sub(r, 10);
  if (ins) out.inset = [1, 2, 3, 4].map((f) => Math.min(60, Math.max(0, fin(one(ins, f)))));
  const raw = sub(r, 1) && one(sub(r, 1), 2);
  if (raw instanceof Uint8Array && raw[0] === 0x62) {
    try {
      for (const run of pb(bv41(raw)).get(1) || []) {
        const rm = pb(run);
        const t = str(one(rm, 1));
        out.text += t;
        if (!out.style && t.trim()) out.style = sub(rm, 2);
      }
    } catch { /* 読めない書式は既定の書式で表示する */ }
  }
  return out;
}

function richStyle(rich, fallbackSize) {
  const valid = (f, v) => v !== undefined && !(f === 40 && !(v > 0));
  const pick = (f) => {
    const a = rich.style ? one(rich.style, f) : undefined;
    if (valid(f, a)) return a;
    const b = rich.def && one(rich.def, f);
    return valid(f, b) ? b : undefined;
  };
  const c = rgba((rich.style && sub(rich.style, 3)) || (rich.def && sub(rich.def, 3))) || [0, 0, 0, 1];
  return {
    size: Math.min(200, Math.max(4, fin(pick(40), fallbackSize))),
    font: str(pick(30)) || '',
    color: toHex(c[0], c[1], c[2]),
  };
}

// テキストボックス: { 1:ID, 20:{1:{x,y}}, 21:{ 2:{w,h} 大きさ固定 | 3:{最小幅,最大幅,最小高さ,最大高さ} 文字に合わせる },
//   22:{1:{1:余白}}, 30:{1:{1:塗りの色}}, 31:{1:枠の太さ, 3:{1:枠の色}}, 32:書式つきの文字 }
function parseText(m) {
  const id = str(one(m, 1));
  const pos = xy(sub(m, 20, 1));
  if (!id || !pos) return null;
  const rich = parseRich(sub(m, 32));
  const st = richStyle(rich, 16);
  // 余白(上・左)。新しい形式は 32.10、古い形式は 22.1.1
  const old = fin(one(sub(m, 22, 1) || new Map(), 1), 5);
  const [it, il, ib, ir] = rich.inset || [old, old, old, old];
  let w, h, wrap = true;
  const fixed = xy(sub(m, 21, 2));
  const auto = sub(m, 21, 3);
  if (fixed && fixed[0] > 0.5) {
    [w, h] = fixed;
  } else if (auto) {
    // 文字の量に合わせて広がる箱: 文字の大きさ + 余白 を最小・最大の間におさめる
    const [minW, maxW, minH] = [1, 2, 3].map((f) => fin(one(auto, f)));
    const cw = rich.content ? rich.content[0] : 0, ch = rich.content ? rich.content[1] : st.size * 1.25;
    const lim = maxW > 0 ? maxW : Infinity;
    w = Math.min(lim, Math.max(minW, cw + il + ir));
    h = Math.max(minH, ch + it + ib);
    // 最大幅に届いていなければ GoodNotes でも1行(改行のところだけで折り返す)。フォントの違いで勝手に折り返さないようにする
    wrap = cw + il + ir >= lim - 1;
  } else return null;
  if (!(w > 0.5)) return null;
  const fill = rgba(sub(m, 30, 1, 1));
  const bw = fin(one(sub(m, 31) || new Map(), 1));
  const bc = rgba(sub(m, 31, 3, 1));
  return {
    id, text: rich.text, x: pos[0], y: pos[1], w, h: Math.max(fin(h), st.size * 1.25), ...st, wrap,
    fill: fill && fill[3] > 0.05 ? toHex(fill[0], fill[1], fill[2]) : null,
    border: bw > 0 && bc && bc[3] > 0.05 ? { w: Math.min(bw, 20), color: toHex(bc[0], bc[1], bc[2]) } : null,
    pad: il, padT: it,
  };
}

// 付箋: { 1:ID, 20:{1:{x,y}}, 21:{2:{w,h}}, 30:{R,G,B,A} 紙の色, 31:書式つきの文字, 33:書いた人の名前 }
function parseSticky(m) {
  const id = str(one(m, 1));
  const pos = xy(sub(m, 20, 1)), size = xy(sub(m, 21, 2));
  if (!id || !pos || !size || !(size[0] > 0.5 && size[1] > 0.5)) return null;
  const rich = parseRich(sub(m, 31));
  const st = richStyle(rich, 24);
  const c = rgba(sub(m, 30)) || [0.98, 0.91, 0.47, 1];
  const author = one(m, 33) instanceof Uint8Array ? str(one(m, 33)) : '';
  return {
    id, text: rich.text, x: pos[0], y: pos[1], w: size[0], h: size[1], ...st, wrap: true,
    fill: toHex(c[0], c[1], c[2]), border: null, radius: 8, pad: 12, padT: 10, foot: author.slice(0, 80),
  };
}

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
    // GoodNotes の白紙は描く命令のない小さな PDF なので、無地のページとして扱う。
    // (名前の「White」は紙の色なので、罫線のある用紙にも付いている。中身で見分ける)
    if (data.length < 4096 && (await isBlankPdf(data))) { pdfHash.set(paper.att, null); continue; }
    const hash = await sha256(data);
    if (!(await db.hasFile(hash))) await db.putFile({ hash, name: title + '.pdf', type: 'application/pdf', data: new Blob([data], { type: 'application/pdf' }) });
    pdfHash.set(paper.att, hash);
  }

  // 3) 大学ノートの変更記録として書き込む
  const noteId = newId();
  const ops = [recorder.make(noteId, 'note.create', { title })];
  const pageIds = [];
  let strokes = 0, images = 0, texts = 0, skippedImages = 0;
  // 画像を保存する(同じ添付は一度だけ)
  const savedImages = new Map();
  const saveImage = async (att) => {
    if (savedImages.has(att)) return savedImages.get(att);
    let res = null;
    const data = await zip.get('attachments/' + att);
    const type = data && imageType(data);
    if (type) {
      const hash = await sha256(data);
      if (!(await db.hasFile(hash))) await db.putFile({ hash, name: `${title}.${type.split('/')[1]}`, type, data: new Blob([data], { type }) });
      res = { hash, type };
    }
    savedImages.set(att, res);
    return res;
  };
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
    const items = new Map(); // 部品ID → 画像・テキストボックス(同じIDが何度も出たら最後のものが最新)
    for (const rec of records(data)) {
      let m;
      try { m = pb(rec); } catch { continue; }
      if (m.has(7)) bodies.push(m.get(7)[0]);
      else if ((m.has(21) || m.has(20)) && m.size === 1) {
        let t = null;
        try { t = m.has(21) ? parseText(pb(one(m, 21))) : parseSticky(pb(one(m, 20))); } catch { t = null; }
        if (t) items.set(t.id, { kind: 'text', ...t });
      } else if (m.has(1) && m.size === 1 && one(m, 1) instanceof Uint8Array) {
        let im = null;
        try { im = parseImage(pb(one(m, 1))); } catch { im = null; }
        if (im) items.set(im.id, { kind: 'image', ...im });
      } else if (m.has(1) && m.has(2)) {
        const id = str(one(m, 1));
        const c = clockOf(one(m, 2));
        const cur = head.get(id);
        if (!cur || c >= cur.c) head.set(id, { c, del: one(m, 3) === 1 });
      }
    }
    // 画像・テキストボックス(手書きより下に表示される)
    for (const it of items.values()) {
      if (head.get(it.id)?.del) continue;
      if (it.kind === 'image') {
        const img = await saveImage(it.att);
        if (!img) { skippedImages++; continue; }
        ops.push(recorder.make(noteId, 'item.add', {
          s: { id: newId(), pageId, tool: 'image', hash: img.hash, mime: img.type, color: '#000000', width: 0, pr: false, pts: cornerPts(it.x, it.y, it.w, it.h), src: 'goodnotes' },
        }));
        images++;
      } else {
        // 文字も枠も塗りもないテキストボックスは、見えないので取り込まない
        if (!it.text.trim() && !it.border && !it.fill) continue;
        ops.push(recorder.make(noteId, 'item.add', {
          s: {
            id: newId(), pageId, tool: 'text', text: it.text, size: Math.round(it.size * 100) / 100, font: it.font, color: it.color,
            fill: it.fill, border: it.border, radius: it.radius || 0, pad: it.pad, padT: it.padT, wrap: it.wrap, foot: it.foot || '',
            width: 0, pr: false, pts: cornerPts(it.x, it.y, it.w, it.h), src: 'goodnotes',
          },
        }));
        texts++;
      }
    }
    for (const b of bodies) {
      let m;
      try { m = pb(b); } catch { continue; }
      const id = str(one(m, 1));
      if (head.get(id)?.del) continue;
      const col = one(m, 4) ? pb(one(m, 4)) : null;
      const [r, g, bb, a] = col ? [one(col, 1) ?? 0, one(col, 2) ?? 0, one(col, 3) ?? 0, one(col, 4) ?? 1] : [0, 0, 0, 1];
      const marker = a < 0.9;
      const s = { id: newId(), pageId, tool: marker ? 'marker' : 'pen', color: toHex(r, g, bb), width: marker ? 12 : 1.6, pr: false, pts: [], src: 'goodnotes' };
      const blob = one(m, 2);
      let raw = null;
      if (blob instanceof Uint8Array && blob.length >= 4 && blob[0] === 0x62) { // 'bv41'
        try { raw = bv41(blob); } catch { raw = null; }
      }
      let got = null;
      const sh = sub(m, 9);
      try { got = (sh && sh.size && shapeLine(sh)) || (raw && strokeLine(raw)); } catch { got = null; }
      if (got && got.empty) continue; // 点のない線(GoodNotes が残した空の記録)
      const r2 = (x) => Math.round(x * 100) / 100;
      // 投げ縄で動かした線は、点はそのままで「ずらす量」(フィールド6)が記録されている
      const [ox, oy] = xy(sub(m, 6)) || [0, 0];
      if (got) {
        let maxW = got.width || 0, minW = Infinity;
        for (const q of got.line) if (q[2] > 0) { maxW = Math.max(maxW, q[2]); minW = Math.min(minW, q[2]); }
        if (minW === Infinity) minW = maxW;
        maxW = Math.min(80, maxW);
        s.width = r2(Math.min(80, Math.max(0.3, got.width || maxW || s.width)));
        // 太さが変わる線は、太さの比を筆圧として持たせる(太さ = width × (0.3 + 筆圧))
        s.pr = !marker && !got.shape && !got.width && maxW > 0 && minW < maxW * 0.9;
        if (s.pr) s.width = r2(Math.max(0.3, maxW));
        if (got.shape) s.shape = true;
        else s.sm = 0.3; // 元の点はなめらかなので、ほとんどならさない
        for (const [x, y, w] of got.line) {
          const p = s.pr ? Math.max(0, Math.min(0.7, w / maxW - 0.3)) : 0.5;
          s.pts.push(r2(x + ox), r2(y + oy), r2(p));
        }
      } else {
        // 形式が分からない線: 座標らしい float の並びを探す(以前からの方法)
        let pts = null;
        try { pts = raw && strokePoints(raw); } catch { pts = null; }
        if (!pts) continue;
        for (let k = 0; k < pts.length; k += 2) s.pts.push(r2(pts[k] + ox), r2(pts[k + 1] + oy), 0.5);
      }
      if (!s.pts.length) continue;
      ops.push(recorder.make(noteId, 'stroke.add', { s }));
      strokes++;
    }
  }
  await db.putOps(ops, recorder.clock);
  return { noteId, title, pages: pageList.length, strokes, images, texts, skippedImages, pageIds };
}

// テスト用
export const _test = { parseTpl, strokeLine };
