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
  // 半円(開いた弧)
  const arc = [];
  for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI; arc.push(100 + Math.cos(a) * 50, 100 + Math.sin(a) * 50, 0.5); }
  assert.equal(shape(arc), null);
  // 星形(5つの角)
  const star = [];
  for (let i = 0; i < 5; i++) { const a = (i * 4 * Math.PI) / 5; star.push([Math.cos(a) * 60, Math.sin(a) * 60]); }
  assert.equal(shape(polygon(star)), null);
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
