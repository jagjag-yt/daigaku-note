// 投げ縄の変形(拡大縮小・回転)とコピー・貼り付け(js/transform.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as TF from '../js/transform.js';

const near = (a, b, eps = 0.02) => assert.ok(Math.abs(a - b) < eps, `${a} ≒ ${b}`);
const stroke = (pts, extra = {}) => ({ id: 's1', pageId: 'p1', tool: 'pen', color: '#000', width: 2, sm: 1, pts, ...extra });

test('拡大縮小: 中心を固定して点と太さに倍率がかかる', () => {
  const d = stroke([0, 0, 0.5, 10, 0, 0.5, 10, 10, 0.5]);
  const out = TF.transformData(d, [0, 0], TF.scaleAbout(0, 0, 2));
  assert.deepEqual(out.pts, [0, 0, 0.5, 20, 0, 0.5, 20, 20, 0.5]);
  assert.equal(out.width, 4);
  assert.equal(out.sm, 2);
  assert.equal(d.width, 2, '元のデータは変えない');
});

test('移動のずれ(off)を足し込んでから変形する', () => {
  const d = stroke([0, 0, 0.5, 10, 0, 0.5]);
  const out = TF.transformData(d, [5, 7], TF.IDENTITY);
  assert.deepEqual(out.pts, [5, 7, 0.5, 15, 7, 0.5]);
  assert.equal(out.width, 2, '倍率1なら太さは変わらない');
});

test('回転: 90°回すと (10,0) は (0,10) へ(中心が原点のとき)', () => {
  const m = TF.rotateAbout(0, 0, Math.PI / 2);
  const [x, y] = TF.apply(m, 10, 0);
  near(x, 0); near(y, 10);
  const out = TF.transformData(stroke([10, 0, 0.5]), [0, 0], m);
  near(out.pts[0], 0); near(out.pts[1], 10);
  assert.equal(out.width, 2, '回転では太さは変わらない');
});

test('回転は中心のまわり: 中心の点は動かない', () => {
  const m = TF.rotateAbout(50, 40, 1.234);
  const [x, y] = TF.apply(m, 50, 40);
  near(x, 50); near(y, 40);
});

test('multiply は右から順にかける', () => {
  const m = TF.multiply(TF.scaleAbout(0, 0, 2), TF.translate(3, 4)); // 先に移動、あとで2倍
  assert.deepEqual(TF.apply(m, 1, 1), [8, 10]);
});

test('テキストボックス: 四角のまま大きさが変わり、文字・余白・枠も小さいほうの倍率で変わる', () => {
  const d = { id: 't', pageId: 'p', tool: 'text', text: 'あ', size: 10, pad: 4, padT: 2, radius: 3, border: { w: 1, color: '#000' }, pts: [0, 0, 0, 100, 0, 0, 100, 50, 0, 0, 50, 0], width: 0 };
  const out = TF.transformData(d, [10, 0], TF.scaleAbout(0, 0, 2));
  assert.deepEqual(out.pts, [20, 0, 0, 220, 0, 0, 220, 100, 0, 20, 100, 0]);
  assert.equal(out.size, 20);
  assert.equal(out.pad, 8);
  assert.equal(out.padT, 4);
  assert.equal(out.border.w, 2);
  assert.equal(d.border.w, 1, '元の枠は変えない');
});

test('画像: 回転しても傾けず、中心だけが回る', () => {
  const d = { id: 'i', pageId: 'p', tool: 'image', hash: 'h', pts: [0, 0, 0, 20, 0, 0, 20, 10, 0, 0, 10, 0], width: 0 };
  const out = TF.transformData(d, [0, 0], TF.rotateAbout(0, 0, Math.PI));
  // 中心 (10,5) が (-10,-5) へ。大きさは 20×10 のまま
  near(out.pts[0], -20); near(out.pts[1], -10); near(out.pts[6], 0); near(out.pts[7], 0);
});

test('画面の途中経過の行列: 部品の元の四角を変形後の四角に移す', () => {
  const d = { tool: 'image', pts: [0, 0, 0, 20, 0, 0, 20, 10, 0, 0, 10, 0] };
  const m = TF.itemMatrix(d, [5, 5], TF.scaleAbout(0, 0, 2));
  // 元の (0,0) は off で (5,5)、2倍で (10,10)
  assert.deepEqual(TF.apply(m, 0, 0), [10, 10]);
  assert.deepEqual(TF.apply(m, 20, 10), [50, 30]);
});

test('isIdentity: ほぼ動かしていない変形は確定しない', () => {
  assert.ok(TF.isIdentity(TF.IDENTITY));
  assert.ok(TF.isIdentity(TF.scaleAbout(10, 10, 1.00001)));
  assert.ok(!TF.isIdentity(TF.scaleAbout(10, 10, 1.1)));
  assert.ok(!TF.isIdentity(TF.rotateAbout(10, 10, 0.1)));
});

test('コピー・貼り付け: id とページを外し、指定した場所を中心に置く。ページからはみ出さない', () => {
  const clip = TF.toClip([stroke([0, 0, 0.5, 10, 10, 0.5])]);
  assert.equal(clip[0].id, undefined);
  assert.equal(clip[0].pageId, undefined);
  const placed = TF.placeClip(clip, 100, 100, { w: 500, h: 500 });
  const b = TF.boundsOf(placed);
  near((b.x0 + b.x1) / 2, 100); near((b.y0 + b.y1) / 2, 100);
  // ページの右下の外を指定しても、ページの中に収まる
  const edge = TF.boundsOf(TF.placeClip(clip, 1000, 1000, { w: 500, h: 500 }));
  assert.ok(edge.x1 <= 500.01 && edge.y1 <= 500.01);
});

test('貼り付け: ページより大きいものは、はみ出したまま中心に置く(縮めない)', () => {
  const big = TF.toClip([stroke([0, 0, 0.5, 800, 0, 0.5])]);
  const b = TF.boundsOf(TF.placeClip(big, 250, 250, { w: 500, h: 500 }));
  near((b.x0 + b.x1) / 2, 250);
  near(b.x1 - b.x0, 802);
});

test('貼り付け: 画像はファイル(hash)と種類をそのまま持つ', () => {
  const img = { id: 'i', pageId: 'p', tool: 'image', hash: 'abc', mime: 'image/png', pts: [0, 0, 0, 20, 0, 0, 20, 10, 0, 0, 10, 0], width: 0 };
  const [out] = TF.placeClip(TF.toClip([img]), 50, 50, { w: 500, h: 500 });
  assert.equal(out.hash, 'abc');
  assert.equal(out.mime, 'image/png');
  assert.equal(out.tool, 'image');
});
