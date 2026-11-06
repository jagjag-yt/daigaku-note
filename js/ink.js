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
// 書き終わり(ペンを止めたとき・離したとき)に、直線・円/楕円・三角形・四角形・多角形に整える。

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

// 点の列と、閉じた多角形 cs のずれの平均
function polyErrOf(pts, cs) {
  let sum = 0;
  for (const q of pts) {
    let m = Infinity;
    for (let i = 0; i < cs.length; i++) m = Math.min(m, segDist(q, cs[i], cs[(i + 1) % cs.length]));
    sum += m;
  }
  return sum / pts.length;
}

// 水平・垂直な長方形を当てはめる。e = [左, 右, 上, 下] の大まかな位置。
// 各点をいちばん近い辺に振り分けて、その中央値を辺の位置にする → [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]
function axisRect(pts, e) {
  const side = [[], [], [], []];
  for (const [x, y] of pts) {
    const ds = [Math.abs(x - e[0]), Math.abs(x - e[1]), Math.abs(y - e[2]), Math.abs(y - e[3])];
    const k = ds.indexOf(Math.min(...ds));
    side[k].push(k < 2 ? x : y);
  }
  const med = (v, f) => { if (!v.length) return f; v.sort((u, w) => u - w); return v[v.length >> 1]; };
  const [x0, x1, y0, y1] = side.map((v, i) => med(v, e[i]));
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

// 角の位置を整える: 角と角のあいだの点(両端の 20% を除く)に直線を当てはめ、となりの直線との交点を角にする。
// 手ぶれで角の点が数 pt ずれていても、辺の向きから正しい位置が求まる。交点が遠すぎるときは元の角のまま
function refineCorners(pts, corners, lim) {
  const n = pts.length, k = corners.length;
  const idx = corners.map((c) => pts.indexOf(c));
  if (idx.some((i) => i < 0)) return corners;
  const lines = [];
  for (let e = 0; e < k; e++) {
    const a = idx[e], b = e + 1 < k ? idx[e + 1] : idx[0] + n;
    const len = b - a;
    const seg = [];
    for (let j = a + Math.ceil(len * 0.2); j <= b - Math.ceil(len * 0.2); j++) seg.push(pts[j % n]);
    if (seg.length < 2) return corners;
    let mx = 0, my = 0;
    for (const q of seg) { mx += q[0]; my += q[1]; }
    mx /= seg.length; my /= seg.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const q of seg) { const dx = q[0] - mx, dy = q[1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    lines.push([mx, my, Math.cos(th), Math.sin(th)]);
  }
  return corners.map((c, e) => {
    const L1 = lines[(e + k - 1) % k], L2 = lines[e];
    const det = L1[2] * L2[3] - L1[3] * L2[2];
    if (Math.abs(det) < 0.2) return c; // ほぼ平行
    const t = ((L2[0] - L1[0]) * L2[3] - (L2[1] - L1[1]) * L2[2]) / det;
    const q = [L1[0] + L1[2] * t, L1[1] + L1[3] * t];
    return dist(q[0], q[1], c[0], c[1]) < lim ? q : c;
  });
}

// 辺がどれだけまっすぐか: 角と角のあいだの点(両端の 20% を除く)が、角を結ぶ線からずれている量の平均を
// 辺の長さで割ったもの。各辺のうち最大の値を返す。ふくらんだ円を多角形とみなさないために使う
function bowOf(ring, corners) {
  const m = ring.length, k = corners.length;
  let worst = 0;
  for (let e = 0; e < k; e++) {
    const A = corners[e], B = corners[(e + 1) % k];
    let ia = ring.indexOf(A), ib = ring.indexOf(B);
    if (ia < 0 || ib < 0) continue;
    if (ib <= ia) ib += m;
    const len = ib - ia, el = dist(A[0], A[1], B[0], B[1]);
    if (!el) continue;
    let sum = 0, cnt = 0;
    for (let j = ia + Math.ceil(len * 0.2); j <= ib - Math.ceil(len * 0.2); j++) { sum += perpDist(ring[j % m], A, B); cnt++; }
    if (cnt) worst = Math.max(worst, sum / cnt / el);
  }
  return worst;
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
  let n = pts.length;
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
  // 書き終わりが始点を通り過ぎていたら、始点にいちばん近づいたところで切る
  {
    let bi = n - 1, bd = chord;
    for (let i = Math.floor(n * 0.7); i < n - 1; i++) {
      const dd = dist(pts[i][0], pts[i][1], first[0], first[1]);
      if (dd < bd) { bd = dd; bi = i; }
    }
    if (bi < n - 1 && bi >= 5) { pts.length = bi + 1; n = pts.length; }
  }
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
  const size = (bx1 - bx0 + by1 - by0) / 2;
  if (bx1 - bx0 < 8 || by1 - by0 < 8) return null;

  // 多角形の候補: 角を探す(始点と終点は必ず頂点として残る)。
  // しきい値は周の長さだけでなく短い辺の長さでも抑える(細長い枠で短い辺を潰さない)
  const minSide = Math.min(bx1 - bx0, by1 - by0);
  const closedPts = [...pts.slice(0, -1), first];
  const simp = douglasPeucker(closedPts, Math.min(L * 0.045, minSide * 0.25));
  // 辺の途中から書き始めると、始点(と終点)が余計な頂点として残る。両隣を結ぶ線の上にある頂点は除く
  const dropStraight = (cs) => {
    while (cs.length > 3) {
      let mi = -1, md = Infinity;
      cs.forEach((c, i) => {
        const dv = perpDist(c, cs[(i + cs.length - 1) % cs.length], cs[(i + 1) % cs.length]);
        if (dv < md) { md = dv; mi = i; }
      });
      if (md > Math.min(L * 0.035, minSide * 0.2)) break;
      cs.splice(mi, 1);
    }
    return cs;
  };
  // そのあと、近すぎる頂点(書き終わりの小さなはみ出しなど)はまとめる
  const corners = [];
  for (const c of dropStraight(simp.slice(0, -1))) {
    if (!corners.some((m) => dist(m[0], m[1], c[0], c[1]) < Math.min(L * 0.06, minSide * 0.3))) corners.push(c);
  }
  dropStraight(corners);
  // 平行な辺があると、ダグラス・ポーカーは辺の途中の点を角に選ぶことがある。
  // 各角を、両どなりの角を結ぶ線からいちばん離れた点(本当の角)に動かし直す
  if (corners.length >= 3 && corners.length <= 8) {
    const ring = closedPts.slice(0, -1), m = ring.length;
    for (let it = 0; it < 3; it++) {
      let moved = false;
      for (let e = 0; e < corners.length; e++) {
        const k = corners.length, A = corners[(e + k - 1) % k], B = corners[(e + 1) % k];
        let ia = ring.indexOf(A), ib = ring.indexOf(B);
        if (ia < 0 || ib < 0) continue;
        if (ib <= ia) ib += m;
        let best = corners[e], bd = perpDist(best, A, B);
        for (let j = ia + 1; j < ib; j++) {
          const q = ring[j % m], dq = perpDist(q, A, B);
          if (dq > bd) { bd = dq; best = q; }
        }
        if (best !== corners[e]) { corners[e] = best; moved = true; }
      }
      if (!moved) break;
    }
    dropStraight(corners);
  }

  // 円・楕円の候補(外接する長方形から)
  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
  let rx = (bx1 - bx0) / 2, ry = (by1 - by0) / 2;
  // 楕円からのずれの平均(pt)。中心から見た方向で、楕円の上の点までの距離を測る
  let ellErr = 0;
  for (const [x, y] of pts) {
    const rho = Math.hypot((x - cx) / rx, (y - cy) / ry);
    ellErr += rho ? Math.abs(1 - 1 / rho) * Math.hypot(x - cx, y - cy) : Math.min(rx, ry);
  }
  ellErr /= n;

  // 辺のまっすぐさ(角を整える前に測る。整えたあとの角は点の列の中にないため)
  const bow = corners.length >= 3 && corners.length <= 8 ? bowOf(closedPts.slice(0, -1), corners) : 1;
  // 角の位置を辺の向きから整える
  const fixed = corners.length >= 3 && corners.length <= 8 ? refineCorners(closedPts.slice(0, -1), corners, size * 0.15) : corners;
  // 多角形からのずれの平均(pt)。整えた角と元の角の、よく沿うほうを使う
  let polyErr = Infinity;
  if (corners.length >= 3 && corners.length <= 8) {
    const e0 = polyErrOf(pts, corners), e1 = polyErrOf(pts, fixed);
    if (e1 < e0) corners.splice(0, corners.length, ...fixed);
    polyErr = Math.min(e0, e1);
  }
  const polyErr34 = corners.length === 3 || corners.length === 4 ? polyErr : Infinity;
  // 角の丸い四角形は、角がうまく見つからない(丸みの途中が角になる)ことがある。
  // 見つかった角の多角形より、外接する長方形のほうがよく沿い、楕円よりはっきり沿っていれば長方形にする
  // (台形・平行四辺形・五角形は、外接する長方形からのずれが大きいので当たらない)
  {
    const rc = axisRect(pts, [bx0, bx1, by0, by1]);
    const rErr = polyErrOf(pts, rc);
    if (rErr < polyErr34 && rErr < ellErr * 0.6 && rErr < size * 0.02) return { type: 'rect', pts: densify(rc, true, p) };
  }
  if (polyErr34 < Infinity) {
    if (polyErr <= ellErr && polyErr < size * 0.06) {
      if (corners.length === 3) return { type: 'triangle', pts: densify(corners, true, p) };
      // 辺がほぼ水平・垂直なら、きれいな長方形にする。
      // 各辺の位置: まず角の位置から大まかに決め、各点をいちばん近い辺に振り分けて、その中央値にする
      // (角の位置は手ぶれで数 pt ずれることがあり、外接する長方形は書き終わりのはみ出しに引っぱられる)。
      // 水平・垂直かどうかは、辺の傾きか、辺の両端の横ずれ(6pt まで)で決める
      // (細長い枠では、角が少しずれるだけで短い辺の向きが大きく変わるため)
      const sx = corners.map((c) => c[0]).sort((u, v) => u - v), sy = corners.map((c) => c[1]).sort((u, v) => u - v);
      const e = [(sx[0] + sx[1]) / 2, (sx[2] + sx[3]) / 2, (sy[0] + sy[1]) / 2, (sy[2] + sy[3]) / 2];
      const rc = axisRect(pts, e), [[x0, y0], , [x1, y1]] = rc;
      const axis = corners.every((c, i) => {
        const d = corners[(i + 1) % 4];
        const ang = Math.abs(Math.atan2(d[1] - c[1], d[0] - c[0])) % (Math.PI / 2);
        const dev = Math.min(ang, Math.PI / 2 - ang);
        return dev < 0.22 || dist(c[0], c[1], d[0], d[1]) * Math.sin(dev) < Math.min(6, minSide * 0.3);
      });
      if (x1 - x0 > 4 && y1 - y0 > 4 && axis) return { type: 'rect', pts: densify(rc, true, p) };
      if (bow < 0.05) return { type: 'quad', pts: densify(corners, true, p) };
    }
  }
  // 五角形・六角形など(角が 5〜8 個): 楕円よりはっきり沿っていれば、角を結んだ多角形にする
  if (corners.length >= 5 && corners.length <= 8) {
    if (bow < 0.05 && polyErr < ellErr * 0.6 && polyErr < size * 0.04) return { type: 'polygon', pts: densify(corners, true, p) };
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
