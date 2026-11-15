// 投げ縄で選んだものの変形(拡大縮小・回転)と、コピー・貼り付け用の形への変換。DOM なし(Node でテストできる)。
//
// 変形は「元の線を消して、変形した線を新しく足す」形で記録する(stroke.del + stroke.add / item.add)。
// 移動(stroke.tf)のように専用の op を足すと、それを知らない古い版のアプリや同期先で形が崩れるため。
// 行列は SVG と同じ [a, b, c, d, e, f](x' = a x + c y + e, y' = b x + d y + f)。

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// m1 のあとに m2(m2 ∘ m1)
export function multiply(m2, m1) {
  return [
    m2[0] * m1[0] + m2[2] * m1[1],
    m2[1] * m1[0] + m2[3] * m1[1],
    m2[0] * m1[2] + m2[2] * m1[3],
    m2[1] * m1[2] + m2[3] * m1[3],
    m2[0] * m1[4] + m2[2] * m1[5] + m2[4],
    m2[1] * m1[4] + m2[3] * m1[5] + m2[5],
  ];
}

export const translate = (dx, dy) => [1, 0, 0, 1, dx, dy];

// (cx, cy) を中心に拡大縮小
export function scaleAbout(cx, cy, sx, sy = sx) {
  return [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
}

// (cx, cy) を中心に回転(ラジアン、画面の向きで時計回りが正)
export function rotateAbout(cx, cy, t) {
  const c = Math.cos(t), s = Math.sin(t);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}

// ページを 90° 単位で回す行列。w, h は回す前のページの大きさ。rot: 90(右回り)/ 180 / 270(左回り)
// 回したあとのページは、90・270 のとき幅と高さが入れ替わる
export function pageRotation(rot, w, h) {
  switch (((rot % 360) + 360) % 360) {
    case 90: return [0, 1, -1, 0, h, 0];
    case 180: return [-1, 0, 0, -1, w, h];
    case 270: return [0, -1, 1, 0, 0, w];
    default: return IDENTITY;
  }
}

// 線の太さなどにかける倍率(面積の比の平方根)
export const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

const r2 = (v) => Math.round(v * 100) / 100;

// 部品(画像・テキストボックス)の四隅から位置と大きさ
function rectOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const corners = (x, y, w, h) => [r2(x), r2(y), 0, r2(x + w), r2(y), 0, r2(x + w), r2(y + h), 0, r2(x), r2(y + h), 0];

const isItem = (d) => d.tool === 'image' || d.tool === 'text';

// 部品は傾けずに、四角のまま中心を動かして大きさを変える(回転は中心の位置だけに効く)。
// 縦横の倍率は、変形後の辺の長さの比
export function itemTarget(d, off, m) {
  const r = rectOf(d.pts);
  const x = r.x + off[0], y = r.y + off[1];
  const [cx, cy] = apply(m, x + r.w / 2, y + r.h / 2);
  const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
  const w = Math.max(1, r.w * sx), h = Math.max(1, r.h * sy);
  return { x: cx - w / 2, y: cy - h / 2, w, h, sx, sy };
}

// 部品だけの、画面で途中経過を見せるための行列(元の四角 → 変形後の四角)
export function itemMatrix(d, off, m) {
  const r = rectOf(d.pts);
  const t = itemTarget(d, off, m);
  const kx = t.w / Math.max(1e-6, r.w), ky = t.h / Math.max(1e-6, r.h);
  // 元の位置 (r.x + off) を t.x へ。off の分は呼ぶ側の translate に含まれないよう、ここで全部持つ
  return [kx, 0, 0, ky, t.x - kx * r.x, t.y - ky * r.y];
}

// 線・部品のデータ d(off だけずらしてある)を、行列 m で変形した新しいデータにする。id は呼ぶ側で付け直す
export function transformData(d, off, m) {
  const out = { ...d };
  if (isItem(d)) {
    const t = itemTarget(d, off, m);
    out.pts = corners(t.x, t.y, t.w, t.h);
    if (d.tool === 'text') {
      // 文字の大きさ・余白・枠は、縦横の倍率の小さいほうに合わせる(文字がはみ出さないように)
      const k = Math.min(t.sx, t.sy);
      if (d.size) out.size = r2(d.size * k);
      if (d.pad != null) out.pad = r2(d.pad * k);
      if (d.padT != null) out.padT = r2(d.padT * k);
      if (d.radius) out.radius = r2(d.radius * k);
      if (d.border) out.border = { ...d.border, w: r2(d.border.w * k) };
    }
    return out;
  }
  const P = d.pts, Q = new Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    const [x, y] = apply(m, P[i] + off[0], P[i + 1] + off[1]);
    Q[i] = r2(x);
    Q[i + 1] = r2(y);
    Q[i + 2] = P[i + 2];
  }
  out.pts = Q;
  const k = scaleOf(m);
  if (k !== 1) {
    out.width = Math.round(d.width * k * 1000) / 1000;
    if (d.sm) out.sm = r2(d.sm * k);
  }
  return out;
}

// 行列が何もしない(とみなせる)か
export function isIdentity(m, eps = 1e-4) {
  return m.every((v, i) => Math.abs(v - IDENTITY[i]) < (i >= 4 ? 0.05 : eps));
}

// 選んだもの(off を足し込んだデータの配列)の外枠
export function boundsOf(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of list) {
    const P = d.pts;
    const m = isItem(d) ? 0 : (d.width || 0) / 2;
    for (let i = 0; i < P.length; i += 3) {
      x0 = Math.min(x0, P[i] - m); x1 = Math.max(x1, P[i] + m);
      y0 = Math.min(y0, P[i + 1] - m); y1 = Math.max(y1, P[i + 1] + m);
    }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

// コピー・貼り付けの中身(off を足し込み、ページと id を外したもの)
export function toClip(list) {
  return list.map(({ id, pageId, ...d }) => d);
}

// 貼り付ける: 外枠の中心が (cx, cy) に来るようにずらし、ページの中に収める
export function placeClip(clip, cx, cy, page) {
  const b = boundsOf(clip);
  if (!b) return [];
  let dx = cx - (b.x0 + b.x1) / 2, dy = cy - (b.y0 + b.y1) / 2;
  if (page) {
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (w < page.w) dx = Math.min(Math.max(dx, -b.x0), page.w - b.x1);
    if (h < page.h) dy = Math.min(Math.max(dy, -b.y0), page.h - b.y1);
  }
  return clip.map((d) => transformData(d, [0, 0], translate(dx, dy)));
}
