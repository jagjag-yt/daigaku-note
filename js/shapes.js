// ペンで描く図形と矢印(ドラッグした範囲に、四角・楕円・三角・ひし形・直線・矢印を描く)。DOM なし。
//
// 図形はふつうの線(stroke.add)として保存する。点の並びに角を入れ、shape の印を付けて
// なめらかにしない(js/ink.js の centerline)。古い版でも同じ形の線として見える。

export const SHAPES = {
  rect: '四角',
  ellipse: '楕円',
  tri: '三角',
  diamond: 'ひし形',
  line: '直線',
  arrow: '矢印',
  arrow2: '両矢印',
};

const r2 = (v) => Math.round(v * 100) / 100;
const flat = (pts, p = 0.5) => pts.flatMap(([x, y]) => [r2(x), r2(y), p]);

// 矢じりの2本の端(先 (x1,y1) から、向き (x0,y0)→(x1,y1) の逆に開く)
function head(x0, y0, x1, y1, w) {
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const L = Math.min(len * 0.4, Math.max(8, w * 4.5)), a = Math.PI / 7;
  const ux = (x0 - x1) / len, uy = (y0 - y1) / len;
  const rot = (t) => [x1 + L * (ux * Math.cos(t) - uy * Math.sin(t)), y1 + L * (ux * Math.sin(t) + uy * Math.cos(t))];
  return [rot(a), rot(-a)];
}

// (x0,y0) から (x1,y1) までドラッグしたときの点の並び [x, y, 筆圧, …]。w は線の太さ(矢じりの大きさに使う)
export function shapePts(kind, x0, y0, x1, y1, w = 2) {
  const L = Math.min(x0, x1), R = Math.max(x0, x1), T = Math.min(y0, y1), B = Math.max(y0, y1);
  const cx = (L + R) / 2, cy = (T + B) / 2;
  switch (kind) {
    case 'rect': return flat([[L, T], [R, T], [R, B], [L, B], [L, T]]);
    case 'tri': return flat([[cx, T], [R, B], [L, B], [cx, T]]);
    case 'diamond': return flat([[cx, T], [R, cy], [cx, B], [L, cy], [cx, T]]);
    case 'ellipse': {
      const rx = (R - L) / 2, ry = (B - T) / 2, n = 96, pts = []; // 大きく拡大しても角が目立たない数
      for (let i = 0; i <= n; i++) { const t = (i / n) * Math.PI * 2 - Math.PI / 2; pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]); }
      return flat(pts);
    }
    case 'line': return flat([[x0, y0], [x1, y1]]);
    case 'arrow': {
      // 1本の線でたどる: 根元 → 先 → 矢じりの片側 → 先 → もう片側
      const [a, b] = head(x0, y0, x1, y1, w);
      return flat([[x0, y0], [x1, y1], a, [x1, y1], b]);
    }
    case 'arrow2': {
      const [a, b] = head(x0, y0, x1, y1, w), [c, d] = head(x1, y1, x0, y0, w);
      return flat([c, [x0, y0], d, [x0, y0], [x1, y1], a, [x1, y1], b]);
    }
    default: return [];
  }
}

// 小さすぎるドラッグ(押しただけ)か
export const tooSmall = (x0, y0, x1, y1, min = 3) => Math.hypot(x1 - x0, y1 - y0) < min;
