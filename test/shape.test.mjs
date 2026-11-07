import test from 'node:test';
import assert from 'node:assert/strict';
import { recognizeShape } from '../js/ink.js';

// 決まった乱数(毎回同じ結果にする)
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const shape = (pts) => recognizeShape(pts)?.type ?? null;

// 多角形を、周の startFrac の位置から一周なぞる(手ぶれ noise pt、行き過ぎ over)
function polygon(cs, { start = 0, noise = 1.5, step = 2, over = 0 } = {}) {
  const segs = []; let P = 0;
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i], b = cs[(i + 1) % cs.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push([a, b, l]); P += l;
  }
  const out = [];
  for (let s = 0; s <= P * (1 + over); s += step) {
    let t = (s + start * P) % P;
    for (const [a, b, l] of segs) {
      if (t <= l) { out.push(a[0] + ((b[0] - a[0]) * t) / l + rnd() * noise, a[1] + ((b[1] - a[1]) * t) / l + rnd() * noise, 0.5); break; }
      t -= l;
    }
  }
  return out;
}
function ellipse(rx, ry, { start = 0, noise = 2, over = 0.03 } = {}) {
  const out = [], k = 90;
  for (let i = 0; i <= k * (1 + over); i++) {
    const a = start + (i / k) * Math.PI * 2;
    out.push(100 + Math.cos(a) * rx + rnd() * noise, 100 + Math.sin(a) * ry + rnd() * noise, 0.5);
  }
  return out;
}
const rot = (cs, deg) => { const r = (deg * Math.PI) / 180; return cs.map(([x, y]) => [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)]); };
const SQ = [[0, 0], [120, 0], [120, 90], [0, 90]];
const TRI = [[0, 0], [110, 0], [40, 90]];

test('四角形は、どこから書き始めても長方形になる', () => {
  for (const start of [0, 0.05, 0.12, 0.2, 0.37, 0.5, 0.63, 0.88]) assert.equal(shape(polygon(SQ, { start })), 'rect', 'start ' + start);
});

test('小さな四角形・行き過ぎた四角形も長方形になる', () => {
  assert.equal(shape(polygon([[0, 0], [30, 0], [30, 22], [0, 22]], { start: 0.3, noise: 0.8, step: 1 })), 'rect');
  assert.equal(shape(polygon(SQ, { start: 0.1, over: 0.06 })), 'rect');
});

test('長方形の辺は、角の位置に合わせて水平・垂直になる', () => {
  const r = recognizeShape(polygon(SQ, { start: 0.3 }));
  const xs = [], ys = [];
  for (let i = 0; i < r.pts.length; i += 3) { xs.push(r.pts[i]); ys.push(r.pts[i + 1]); }
  assert.ok(Math.abs(Math.min(...xs)) < 3 && Math.abs(Math.max(...xs) - 120) < 3);
  assert.ok(Math.abs(Math.min(...ys)) < 3 && Math.abs(Math.max(...ys) - 90) < 3);
});

test('傾いた四角形は四角形(quad)のまま整える', () => {
  assert.equal(shape(polygon(rot(SQ, 30), { start: 0.4 })), 'quad');
});

test('三角形は、どこから書き始めても三角形になる', () => {
  for (const start of [0, 0.1, 0.25, 0.5, 0.7]) assert.equal(shape(polygon(TRI, { start })), 'triangle', 'start ' + start);
  assert.equal(shape(polygon(rot(TRI, 50), { start: 0.33 })), 'triangle');
});

test('円・楕円', () => {
  for (const r of [15, 40, 120]) assert.equal(shape(ellipse(r, r * 1.05, { noise: r * 0.05 })), 'circle', 'r ' + r);
  assert.equal(shape(ellipse(90, 45)), 'ellipse');
  assert.equal(shape(ellipse(50, 48, { start: 2 })), 'circle');
});

test('直線', () => {
  const pts = [];
  for (let i = 0; i <= 60; i++) pts.push(i * 3, 10 + Math.sin(i / 5) * 1.2 + rnd(), 0.5);
  assert.equal(shape(pts), 'line');
});

test('図形でないものは整えない', () => {
  // ジグザグ(W)
  const w = [];
  for (let i = 0; i <= 80; i++) w.push(i * 2, (i % 20 < 10 ? i % 20 : 20 - (i % 20)) * 6, 0.5);
  assert.equal(shape(w), null);
  // 渦巻き
  const sp = [];
  for (let i = 0; i <= 120; i++) { const a = i / 10; sp.push(100 + Math.cos(a) * a * 6, 100 + Math.sin(a) * a * 6, 0.5); }
  assert.equal(shape(sp), null);
  // 点・短い線
  assert.equal(shape([0, 0, 0.5, 1, 1, 0.5, 2, 1, 0.5]), null);
});

test('細長い枠(単語を囲む四角)も長方形になる', () => {
  for (const [w, h] of [[80, 20], [150, 25], [200, 30], [300, 40]]) {
    for (const start of [0, 0.2, 0.45]) assert.equal(shape(polygon([[0, 0], [w, 0], [w, h], [0, h]], { start, noise: 1.2, step: 1.5, over: 0.04 })), 'rect', `${w}x${h} start ${start}`);
  }
});

test('角の丸い四角形も長方形になる', () => {
  for (const f of [0.1, 0.2]) {
    const r = 90 * f, cs = [];
    const arc = (cx, cy, a0) => { for (let i = 0; i <= 8; i++) { const a = a0 + (i / 8) * (Math.PI / 2); cs.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
    arc(r, r, Math.PI); arc(120 - r, r, 1.5 * Math.PI); arc(120 - r, 90 - r, 0); arc(r, 90 - r, 0.5 * Math.PI);
    assert.equal(shape(polygon(cs, { start: 0.3, step: 1.5 })), 'rect', 'r ' + f);
  }
});

test('台形・平行四辺形・五角形は長方形にしない', () => {
  for (const k of [20, 30, 40]) assert.equal(shape(polygon([[k, 0], [120 - k, 0], [120, 80], [0, 80]], { start: 0.2 })), 'quad', '台形 ' + k);
  for (const k of [20, 30]) assert.equal(shape(polygon([[k, 0], [120 + k, 0], [120, 80], [0, 80]], { start: 0.2 })), 'quad', '平行四辺形 ' + k);
  assert.notEqual(shape(polygon([[50, 0], [100, 40], [100, 100], [0, 100], [0, 40]], { start: 0.1 })), 'rect', '家の形');
});

test('五角形・六角形・星形は多角形になる', () => {
  const reg = (k, r, rot = 0) => Array.from({ length: k }, (_, i) => [Math.cos(rot + (i * 2 * Math.PI) / k) * r, Math.sin(rot + (i * 2 * Math.PI) / k) * r]);
  for (const r of [30, 60, 150]) {
    for (const start of [0, 0.13, 0.5]) {
      assert.equal(shape(polygon(reg(5, r, -Math.PI / 2), { start, noise: r * 0.02 })), 'polygon', `五角形 r${r} start ${start}`);
      assert.equal(shape(polygon(reg(6, r), { start, noise: r * 0.02 })), 'polygon', `六角形 r${r} start ${start}`);
    }
  }
  // 家の形(五角形)
  assert.equal(shape(polygon([[50, 0], [100, 40], [100, 100], [0, 100], [0, 40]], { start: 0.1 })), 'polygon');
  // 星形(5つの角、線が交わる)
  const star = [];
  for (let i = 0; i < 5; i++) { const a = (i * 4 * Math.PI) / 5; star.push([Math.cos(a) * 60, Math.sin(a) * 60]); }
  assert.equal(shape(polygon(star)), 'polygon');
});

test('円は多角形にしない', () => {
  for (const r of [12, 25, 60, 150]) for (const ov of [0, 0.05, 0.15]) {
    const t = shape(ellipse(r, r * 1.04, { noise: r * 0.06, over: ov }));
    assert.ok(t === 'circle' || t === 'ellipse', `r${r} over ${ov}: ${t}`);
  }
});

test('角の少し丸い台形・ひし形・傾いた四角形は四角形(quad)のまま', () => {
  // 角を Chaikin で2回丸める
  const round = (cs, cut) => {
    let r = cs;
    for (let it = 0; it < 2; it++) {
      const o = [];
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        o.push([a[0] + (b[0] - a[0]) * cut, a[1] + (b[1] - a[1]) * cut], [a[0] + (b[0] - a[0]) * (1 - cut), a[1] + (b[1] - a[1]) * (1 - cut)]);
      }
      r = o;
    }
    return r;
  };
  const shapes = { 台形: [[30, 0], [90, 0], [120, 80], [0, 80]], ひし形: [[50, 0], [100, 60], [50, 120], [0, 60]], 傾いた四角形: rot(SQ, 25), 平行四辺形: [[30, 0], [150, 0], [120, 80], [0, 80]] };
  // 書き始めは辺の途中と、角の少し手前・少し後(点の列の一周の境目を角がまたぐ)
  for (const [name, cs] of Object.entries(shapes)) {
    for (const start of [0.3, 0.98, 0.99, 0.01, 0.24, 0.26]) assert.equal(shape(polygon(round(cs, 0.08), { start, noise: 1, step: 1.5 })), 'quad', `${name} start ${start}`);
  }
});

test('ジグザグ(取り消し線)・W は多角形にしない', () => {
  for (const n of [4, 8]) {
    const z = [];
    for (let i = 0; i <= n; i++) z.push([i % 2 ? 100 : 0, i * 10]);
    const pts = [];
    for (let i = 0; i < n; i++) { const a = z[i], b = z[i + 1]; for (let t = 0; t < 1; t += 0.05) pts.push(a[0] + (b[0] - a[0]) * t + rnd(), a[1] + (b[1] - a[1]) * t + rnd(), 0.5); }
    assert.notEqual(shape(pts), 'polygon', 'zigzag open ' + n);
  }
  const w = [[0, 0], [20, 40], [40, 5], [60, 40], [80, 0]], wp = [];
  for (let i = 0; i < 4; i++) { const a = w[i], b = w[i + 1]; for (let t = 0; t < 1; t += 0.05) wp.push(a[0] + (b[0] - a[0]) * t + rnd(), a[1] + (b[1] - a[1]) * t + rnd(), 0.5); }
  assert.notEqual(shape(wp), 'polygon', 'W');
});

const arc = (r, a0, a1, { noise = 1, k = 60 } = {}) => {
  const out = [];
  for (let i = 0; i <= k; i++) { const a = a0 + ((a1 - a0) * i) / k; out.push(100 + Math.cos(a) * r + rnd() * noise, 100 + Math.sin(a) * r + rnd() * noise, 0.5); }
  return out;
};

test('曲線(円の一部)は弧になる', () => {
  for (const r of [25, 60, 200]) {
    for (const [a0, a1] of [[0, Math.PI / 2], [0, Math.PI], [1, 1 + 1.5 * Math.PI], [3, 3 - 2]]) {
      const res = recognizeShape(arc(r, a0, a1, { noise: Math.max(0.6, r * 0.015) }));
      assert.equal(res?.type, 'arc', `r${r} ${a0}→${a1}`);
      // 端は書いたところの近く
      assert.ok(Math.hypot(res.pts[0] - (100 + Math.cos(a0) * r), res.pts[1] - (100 + Math.sin(a0) * r)) < 3);
    }
  }
});

test('S字・波線・ほぼ直線は弧にしない', () => {
  const s = [];
  for (let i = 0; i <= 80; i++) { const t = i / 80; s.push(t * 150, Math.sin(t * Math.PI * 2) * 30, 0.5); }
  assert.notEqual(shape(s), 'arc', 'S字');
  const w = [];
  for (let i = 0; i <= 120; i++) w.push(i * 2, Math.sin(i / 6) * 8, 0.5);
  assert.notEqual(shape(w), 'arc', '波線');
  const l = [];
  for (let i = 0; i <= 60; i++) l.push(i * 3, 10 + Math.sin(i / 5) * 1.2 + rnd(), 0.5);
  assert.equal(shape(l), 'line', 'ほぼ直線');
});
