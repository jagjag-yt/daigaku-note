// 消しゴムで「なぞった所だけ」消す計算(js/erase.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ER from '../js/erase.js';

test('densify: 長い辺の途中に点を足す(筆圧もなめらかに)', () => {
  const out = ER.densify([0, 0, 0, 10, 0, 1], 2.5);
  assert.equal(out.length / 3, 5); // 0, 2.5, 5, 7.5, 10
  assert.deepEqual(out.slice(3, 6), [2.5, 0, 0.25]);
  assert.deepEqual(out.slice(-3), [10, 0, 1]);
});

test('cutPieces: 円に入った点を除いて、前後2つのかけらに分ける', () => {
  const P = ER.densify([0, 0, 0.5, 20, 0, 0.5], 1);
  const out = ER.cutPieces([P], 10, 0, 2);
  assert.equal(out.length, 2);
  assert.ok(out[0].every((v, i) => i % 3 !== 0 || v < 8.01));
  assert.ok(out[1].every((v, i) => i % 3 !== 0 || v > 11.99));
});

test('cutPieces: 当たらなければ同じ配列を返す', () => {
  const pieces = [[0, 0, 0.5, 5, 0, 0.5]];
  assert.equal(ER.cutPieces(pieces, 100, 100, 3), pieces);
});

test('cutPieces: 線の端を消すと、かけらは1つになる', () => {
  const P = ER.densify([0, 0, 0.5, 20, 0, 0.5], 1);
  const out = ER.cutPieces([P], 0, 0, 3);
  assert.equal(out.length, 1);
  assert.equal(out[0][0], 4);
});

test('cutPieces: 全部消すと、かけらはなくなる', () => {
  assert.deepEqual(ER.cutPieces([[0, 0, 0.5, 1, 0, 0.5]], 0.5, 0, 5), []);
});

test('keepPieces: 点1つや短すぎるかけらは残さない', () => {
  const kept = ER.keepPieces([[0, 0, 0.5], [0, 0, 0.5, 0.1, 0, 0.5], [0, 0, 0.5, 5, 0, 0.5]], 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0][3], 5);
});

test('pieceData: id を外し、色・太さ・筆圧の種類・図形の印は残す', () => {
  const d = { id: 'x', pageId: 'p', tool: 'pen', color: '#f00', width: 2, pr: 2, sm: 1, shape: 'rect', nib: 'brush', dash: 'dot', pts: [] };
  const out = ER.pieceData(d, [1.234, 2.345, 0.12345, 3, 4, 0.5]);
  assert.equal(out.id, undefined);
  assert.equal(out.shape, 'rect', '図形のかけらは角を丸めない');
  assert.equal(out.pageId, 'p');
  assert.equal(out.color, '#f00');
  assert.equal(out.pr, 2);
  assert.equal(out.nib, 'brush', 'ペン先の種類も残す');
  assert.equal(out.dash, 'dot', '線の種類も残す');
  assert.deepEqual(out.pts, [1.23, 2.35, 0.123, 3, 4, 0.5]);
});

test('図形の長い辺の途中も消せる(点を細かくしてから切る)', () => {
  const rect = [0, 0, 0.5, 100, 0, 0.5, 100, 100, 0.5];
  const raw = [rect];
  assert.equal(ER.cutPieces(raw, 50, 0, 3), raw, '細かくしないと辺の途中には点がないので消えない');
  const out = ER.cutPieces([ER.densify(rect, 1)], 50, 0, 3);
  assert.equal(out.length, 2);
});
