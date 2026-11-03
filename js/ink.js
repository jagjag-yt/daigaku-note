// 線の形を作る(画面と PDF 書き出しで共通)。DOM に依存しない。
//
// - 筆圧で太さが変わる線: 中心線を滑らかにしてから、左右の輪郭を作って「塗る」。
// - 太さが一定の線(マウス・蛍光ペン・図形): 滑らかにした中心線を「なぞる」。
// どちらもベクター(パス)なので、拡大しても PDF にしてもギザギザにならない。

import { widthAt } from './model.js';

const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

// 入力の点 [x,y,p,...] → 滑らかな中心線 [[x,y,p], ...]
//
// ペンの点は間隔がばらばら(速く動かすと間が空き、遅いとほぼ重なる)。そのまま曲線でつなぐと
// 行き過ぎて小さな輪(結び目)ができるので、まず一定の間隔に並べ直してから、なめらかにする。
export function centerline(d) {
  const P = d.pts;
  const n = P.length / 3;
  const raw = [];
  for (let i = 0; i < n; i++) raw.push([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
  if (d.shape || n < 3) return raw; // 図形は角を残す

  // 1) 一定の間隔で並べ直す
  // sm: ならす強さ(pt)。書いたときの拡大率から決めて線に保存してある(拡大して小さな字を書くと小さくなる)
  const sm = d.sm || 1.5;
  const step = Math.max(0.25, Math.min(1.5, d.width * 0.5, sm));
  const rs = [raw[0]];
  let carry = 0; // 最後に置いた点からの距離
  for (let i = 1; i < n; i++) {
    const a = raw[i - 1], b = raw[i];
    const seg = dist(a[0], a[1], b[0], b[1]);
    if (seg === 0) continue;
    let t = step - carry;
    while (t <= seg) {
      const u = t / seg;
      rs.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
      t += step;
    }
    carry = seg - (t - step);
  }
  const last = raw[n - 1], tail = rs[rs.length - 1];
  if (rs.length > 1 && dist(tail[0], tail[1], last[0], last[1]) < step * 0.4) rs[rs.length - 1] = last;
  else rs.push(last);
  if (rs.length < 3) return rs;

  // 2) 手ぶれをならす(ガウスの重み付き平均)。両端に近い点ほど平均する範囲を狭め、端の点は動かさない。
  //    平均する範囲を画面上で数 px に限っているので、書いている最中に新しい点が来ても形が変わるのは
  //    ペン先のごく近くだけ(以前は広い範囲が毎回動き、線がペン先につられて揺れていた)
  const blur = (k, sigmaPt) => {
    const sg = sigmaPt / step, R = Math.ceil(sg * 2);
    const wt = []; for (let j = 0; j <= R; j++) wt.push(Math.exp(-(j * j) / (2 * sg * sg)));
    const src = rs.map((q) => q[k]), n = src.length;
    for (let i = 1; i < n - 1; i++) {
      const r = Math.min(R, i, n - 1 - i);
      let sum = src[i] * wt[0], w = wt[0];
      for (let j = 1; j <= r; j++) { sum += (src[i - j] + src[i + j]) * wt[j]; w += 2 * wt[j]; }
      rs[i][k] = sum / w;
    }
  };
  blur(0, sm);
  blur(1, sm);
  blur(2, sm * 2);
  return rs;
}

export const variableWidth = (d) => d.pr && !d.shape && d.tool !== 'marker';

// 筆圧つきの線の輪郭(多角形) [[x,y], ...]
export function outline(d, line = centerline(d)) {
  const m = line.length;
  const w = line.map((q) => widthAt(d, q[2]) / 2);
  if (m === 1) return circle(line[0][0], line[0][1], w[0]);
  const L = [], R = [];
  // 急に曲がるところでは、内側の輪郭が逆戻りして小さな輪(結び目)になる。
  // 進む向きに対して後ろへ戻る点は捨てて、輪ができないようにする。
  const keep = (side, q, tx, ty, i) => {
    const last = side[side.length - 1];
    if (!last || i === m - 1 || (q[0] - last[0]) * tx + (q[1] - last[1]) * ty > 0) side.push(q);
  };
  // 向き(法線)は前後に少し離れた点(ならす強さに合わせる)から求める。隣の点だけで求めると、小さな揺れで
  // 向きがぶれて輪郭に段ができる
  let span = 1;
  if (m > 2) {
    const len = line.reduce((s, q, i) => (i ? s + dist(line[i - 1][0], line[i - 1][1], q[0], q[1]) : 0), 0);
    span = Math.max(1, Math.min(4, Math.round((d.sm || 1.5) * 1.3 / (len / (m - 1) || 1))));
  }
  for (let i = 0; i < m; i++) {
    const a = line[Math.max(0, i - span)], b = line[Math.min(m - 1, i + span)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const [x, y] = line[i];
    keep(L, [x - ty * w[i], y + tx * w[i]], tx, ty, i);
    keep(R, [x + ty * w[i], y - tx * w[i]], tx, ty, i);
  }
  const cap = (c, r, from, to) => {
    const pts = [];
    const a0 = Math.atan2(from[1] - c[1], from[0] - c[0]);
    for (let k = 1; k < 8; k++) {
      const a = a0 - (Math.PI * k) / 8;
      pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
    }
    return pts;
  };
  const end = line[m - 1], start = line[0];
  return [
    ...L,
    ...cap(end, w[m - 1], L[L.length - 1], R[R.length - 1]),
    ...R.reverse(),
    ...cap(start, w[0], R[R.length - 1], L[0]),
  ];
}

function circle(x, y, r) {
  const pts = [];
  for (let k = 0; k < 16; k++) pts.push([x + Math.cos((k * Math.PI) / 8) * r, y + Math.sin((k * Math.PI) / 8) * r]);
  return pts;
}

// 多角形の頂点の中点をつなぐ二次曲線で、なめらかな閉じたパスにする(SVG のパス文字列)
export function smoothClosedPath(poly, map = (x, y) => [x, y]) {
  const n = poly.length;
  const P = poly.map(([x, y]) => map(x, y));
  const mid = (i) => {
    const a = P[i % n], b = P[(i + 1) % n];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  const f = (v) => Math.round(v * 100) / 100;
  let s = `M${f(mid(0)[0])} ${f(mid(0)[1])}`;
  for (let i = 1; i <= n; i++) {
    const c = P[i % n], e = mid(i);
    s += `Q${f(c[0])} ${f(c[1])} ${f(e[0])} ${f(e[1])}`;
  }
  return s + 'Z';
}

export function linePath(line, map = (x, y) => [x, y]) {
  const f = (v) => Math.round(v * 100) / 100;
  return line.map(([x, y], i) => {
    const [X, Y] = map(x, y);
    return `${i ? 'L' : 'M'}${f(X)} ${f(Y)}`;
  }).join('');
}

// 1本の線の形(SVG のパス)。画面・サムネイル・PDF で共通に使う
export function geometry(d) {
  const line = centerline(d);
  if (variableWidth(d)) return { kind: 'fill', d: smoothClosedPath(outline(d, line)) };
  if (line.length === 1) {
    const [x, y] = line[0];
    return { kind: 'stroke', d: `M${x} ${y}h0`, w: d.width };
  }
  return { kind: 'stroke', d: linePath(line), w: d.width };
}

// SVG の要素(文字列)
export function strokeSvg(id, d, geo, off = [0, 0]) {
  const tf = off[0] || off[1] ? ` transform="translate(${off[0]} ${off[1]})"` : '';
  const mk = d.tool === 'marker' ? ' class="marker"' : '';
  if (geo.kind === 'fill') return `<path data-id="${id}"${mk}${tf} d="${geo.d}" fill="${d.color}"/>`;
  return `<path data-id="${id}"${mk}${tf} d="${geo.d}" fill="none" stroke="${d.color}" stroke-width="${geo.w}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// キャンバスに1本描く(サムネイル用)
export function drawStroke(ctx, d, off = [0, 0], geo = geometry(d)) {
  ctx.save();
  if (off[0] || off[1]) ctx.translate(off[0], off[1]);
  if (d.tool === 'marker') {
    ctx.globalAlpha = 0.38;
    ctx.globalCompositeOperation = 'multiply';
  }
  const path = new Path2D(geo.d);
  if (geo.kind === 'fill') {
    ctx.fillStyle = d.color;
    ctx.fill(path);
  } else {
    ctx.strokeStyle = d.color;
    ctx.lineWidth = geo.w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }
  ctx.restore();
}

// ---------- 図形補正 ----------
// 書き終わりにペンを止めると、直線・円/楕円・三角形・四角形に整える。

function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  if (!l) return dist(p[0], p[1], a[0], a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / l;
}

// 点 p と線分 ab の距離
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return dist(p[0], p[1], a[0] + t * dx, a[1] + t * dy);
}

function douglasPeucker(pts, eps) {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const a = douglasPeucker(pts.slice(0, idx + 1), eps);
  const b = douglasPeucker(pts.slice(idx), eps);
  return [...a.slice(0, -1), ...b];
}

function densify(corners, closed, p) {
  const out = [];
  const seq = closed ? [...corners, corners[0]] : corners;
  for (let i = 0; i < seq.length - 1; i++) {
    const [ax, ay] = seq[i], [bx, by] = seq[i + 1];
    const k = Math.max(1, Math.ceil(dist(ax, ay, bx, by) / 4));
    for (let j = 0; j < k; j++) out.push(ax + ((bx - ax) * j) / k, ay + ((by - ay) * j) / k, p);
  }
  const e = seq[seq.length - 1];
  out.push(e[0], e[1], p);
  return out;
}

// pts: [x,y,p,...] → {type, pts} または null
export function recognizeShape(flat) {
  const pts = [];
  let psum = 0;
  for (let i = 0; i < flat.length; i += 3) { pts.push([flat[i], flat[i + 1]]); psum += flat[i + 2]; }
  const n = pts.length;
  if (n < 6) return null;
  const p = Math.round((psum / n) * 100) / 100;
  let L = 0;
  for (let i = 1; i < n; i++) L += dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  if (L < 12) return null;
  const first = pts[0], last = pts[n - 1];
  const chord = dist(first[0], first[1], last[0], last[1]);

  // 直線
  let maxDev = 0;
  for (const q of pts) maxDev = Math.max(maxDev, perpDist(q, first, last));
  if (chord > 10 && maxDev < Math.max(3, chord * 0.07)) {
    return { type: 'line', pts: densify([first, last], false, p) };
  }

  // 閉じた図形(始点と終点が近い)
  if (chord > L * 0.22) return null;
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
  const size = (bx1 - bx0 + by1 - by0) / 2;
  if (bx1 - bx0 < 8 || by1 - by0 < 8) return null;

  // 多角形の候補: 角を探す(始点と終点は必ず頂点として残る)
  const closedPts = [...pts.slice(0, -1), first];
  const simp = douglasPeucker(closedPts, L * 0.045);
  // 辺の途中から書き始めると、始点(と終点)が余計な頂点として残る。両隣を結ぶ線の上にある頂点は除く
  const dropStraight = (cs) => {
    while (cs.length > 3) {
      let mi = -1, md = Infinity;
      cs.forEach((c, i) => {
        const dv = perpDist(c, cs[(i + cs.length - 1) % cs.length], cs[(i + 1) % cs.length]);
        if (dv < md) { md = dv; mi = i; }
      });
      if (md > L * 0.035) break;
      cs.splice(mi, 1);
    }
    return cs;
  };
  // そのあと、近すぎる頂点(書き終わりの小さなはみ出しなど)はまとめる
  const corners = [];
  for (const c of dropStraight(simp.slice(0, -1))) {
    if (!corners.some((m) => dist(m[0], m[1], c[0], c[1]) < L * 0.06)) corners.push(c);
  }
  dropStraight(corners);

  // 円・楕円の候補(外接する長方形から)
  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
  let rx = (bx1 - bx0) / 2, ry = (by1 - by0) / 2;
  let ellErr = 0;
  for (const [x, y] of pts) ellErr += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
  ellErr = (ellErr / n) * ((rx + ry) / 2); // 円からのずれの平均(pt)

  if (corners.length === 3 || corners.length === 4) {
    // 多角形からのずれの平均(pt)
    let polyErr = 0;
    for (const q of pts) {
      let m = Infinity;
      for (let i = 0; i < corners.length; i++) m = Math.min(m, segDist(q, corners[i], corners[(i + 1) % corners.length]));
      polyErr += m;
    }
    polyErr /= n;
    if (polyErr <= ellErr && polyErr < size * 0.06) {
      if (corners.length === 3) return { type: 'triangle', pts: densify(corners, true, p) };
      // 辺がほぼ水平・垂直なら、きれいな長方形にする
      const axis = corners.every((c, i) => {
        const d = corners[(i + 1) % 4];
        const ang = Math.abs(Math.atan2(d[1] - c[1], d[0] - c[0])) % (Math.PI / 2);
        return Math.min(ang, Math.PI / 2 - ang) < 0.22;
      });
      if (axis) {
        // 各辺の位置: まず角の位置から大まかに決め、各点をいちばん近い辺に振り分けて、その中央値にする
        // (角の位置は手ぶれで数 pt ずれることがあり、外接する長方形は書き終わりのはみ出しに引っぱられる)
        const sx = corners.map((c) => c[0]).sort((u, v) => u - v), sy = corners.map((c) => c[1]).sort((u, v) => u - v);
        const e = [(sx[0] + sx[1]) / 2, (sx[2] + sx[3]) / 2, (sy[0] + sy[1]) / 2, (sy[2] + sy[3]) / 2];
        const side = [[], [], [], []];
        for (const [x, y] of pts) {
          const ds = [Math.abs(x - e[0]), Math.abs(x - e[1]), Math.abs(y - e[2]), Math.abs(y - e[3])];
          const k = ds.indexOf(Math.min(...ds));
          side[k].push(k < 2 ? x : y);
        }
        const med = (v, f) => { if (!v.length) return f; v.sort((u, w) => u - w); return v[v.length >> 1]; };
        const [x0, x1, y0, y1] = side.map((v, i) => med(v, e[i]));
        return { type: 'rect', pts: densify([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true, p) };
      }
      return { type: 'quad', pts: densify(corners, true, p) };
    }
  }
  if (rx < 4 || ry < 4 || ellErr > size * 0.08) return null;
  if (rx / ry > 0.85 && rx / ry < 1.18) rx = ry = (rx + ry) / 2;
  const out = [];
  const k = Math.max(24, Math.ceil((Math.PI * (rx + ry)) / 3));
  for (let i = 0; i <= k; i++) {
    const a = (i / k) * Math.PI * 2;
    out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, p);
  }
  return { type: rx === ry ? 'circle' : 'ellipse', pts: out };
}

// ---------- 投げ縄 ----------
export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 線の点の半分以上が投げ縄の中にあれば選ぶ
export function strokeInLasso(e, poly) {
  const P = e.data.pts;
  let inside = 0;
  const n = P.length / 3;
  for (let i = 0; i < P.length; i += 3) if (pointInPolygon(P[i] + e.off[0], P[i + 1] + e.off[1], poly)) inside++;
  return inside / n >= 0.5;
}
