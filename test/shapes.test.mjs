// ペンで描く図形と矢印(js/shapes.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapePts, tooSmall, SHAPES } from '../js/shapes.js';

const xy = (P) => { const o = []; for (let i = 0; i < P.length; i += 3) o.push([P[i], P[i + 1]]); return o; };

test('四角: 逆向きにドラッグしても同じ四角(閉じた5点)', () => {
  const a = xy(shapePts('rect', 0, 0, 100, 50)), b = xy(shapePts('rect', 100, 50, 0, 0));
  assert.deepEqual(a, b);
  assert.equal(a.length, 5);
  assert.deepEqual(a[0], a[4]);
});

test('楕円: 範囲の中に収まり、閉じている', () => {
  const p = xy(shapePts('ellipse', 10, 20, 110, 80));
  for (const [x, y] of p) { assert.ok(x >= 9.99 && x <= 110.01); assert.ok(y >= 19.99 && y <= 80.01); }
  assert.ok(Math.hypot(p[0][0] - p.at(-1)[0], p[0][1] - p.at(-1)[1]) < 0.01);
});

test('矢印: 根元から先へ、先には矢じりの2本(先の点を2回通る)', () => {
  const p = xy(shapePts('arrow', 0, 0, 100, 0, 2));
  assert.deepEqual(p[0], [0, 0]);
  assert.deepEqual(p[1], [100, 0]);
  assert.deepEqual(p[3], [100, 0]);
  assert.ok(p[2][0] < 100 && p[4][0] < 100, '矢じりは先より手前に開く');
  assert.ok(p[2][1] * p[4][1] < 0, '矢じりは上下に開く');
});

test('両矢印は両端に矢じり。直線は2点', () => {
  assert.equal(xy(shapePts('arrow2', 0, 0, 100, 0)).length, 8);
  assert.equal(xy(shapePts('line', 0, 0, 30, 40)).length, 2);
});

test('知らない種類は空、押しただけは小さすぎる', () => {
  assert.deepEqual(shapePts('star', 0, 0, 1, 1), []);
  assert.ok(tooSmall(0, 0, 1, 1));
  assert.ok(!tooSmall(0, 0, 10, 0));
  assert.equal(Object.keys(SHAPES).length, 7);
});
