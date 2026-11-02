import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, buildNote, pagesOf, strokesOf } from '../js/model.js';

const stroke = (id, pageId) => ({ s: { id, pageId, color: '#000', width: 2, pr: false, pts: [1, 1, .5, 5, 5, .5] } });

function shuffle(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const summary = (n) => JSON.stringify({ t: n.title, d: n.deleted, pages: pagesOf(n).map((p) => [p.id, strokesOf(n, p.id).map((s) => s.id)]) });

test('2台で別々に書いた線が両方残り、適用順に関係なく同じ結果になる', () => {
  const A = new Recorder('aaaa'), B = new Recorder('bbbb');
  const base = [A.make('n1', 'note.create', { title: '数学' }), A.make('n1', 'page.add', { page: { id: 'p1', w: 100, h: 100, order: 1, bg: { type: 'blank' } } })];
  base.forEach((o) => B.observe(o));
  const a = [A.make('n1', 'stroke.add', stroke('sa', 'p1')), A.make('n1', 'note.rename', { title: '数学A' })];
  const b = [B.make('n1', 'stroke.add', stroke('sb', 'p1')), B.make('n1', 'note.rename', { title: '数学B' })];
  const all = [...base, ...a, ...b];
  const ref = summary(buildNote('n1', all));
  for (let i = 0; i < 20; i++) assert.equal(summary(buildNote('n1', shuffle(all))), ref);
  const n = buildNote('n1', all);
  assert.deepEqual(strokesOf(n, 'p1').map((s) => s.id).sort(), ['sa', 'sb']);
  assert.equal(n.title, '数学B'); // 同じ時計なら端末IDの大きい方が勝つ(決定的)
});

test('消しゴムと元に戻す', () => {
  const A = new Recorder('aaaa');
  const ops = [A.make('n', 'note.create', { title: 'x' }), A.make('n', 'page.add', { page: { id: 'p', w: 1, h: 1, order: 1 } }), A.make('n', 'stroke.add', stroke('s1', 'p'))];
  ops.push(A.make('n', 'stroke.del', { ids: ['s1'] }));
  assert.equal(strokesOf(buildNote('n', ops), 'p').length, 0);
  ops.push(A.make('n', 'stroke.undel', { ids: ['s1'] }));
  assert.equal(strokesOf(buildNote('n', ops), 'p').length, 1);
  // 消す op が線より先に届いても壊れない
  assert.equal(strokesOf(buildNote('n', [...ops].reverse()), 'p').length, 1);
});

test('同じ op を何度取り込んでも結果は同じ', () => {
  const A = new Recorder('aaaa');
  const ops = [A.make('n', 'note.create', { title: 'x' }), A.make('n', 'page.add', { page: { id: 'p', w: 1, h: 1, order: 1 } }), A.make('n', 'stroke.add', stroke('s1', 'p'))];
  assert.equal(summary(buildNote('n', [...ops, ...ops, ...ops])), summary(buildNote('n', ops)));
});

test('ページの順番と削除', () => {
  const A = new Recorder('aaaa');
  const pg = (id, order) => A.make('n', 'page.add', { page: { id, w: 1, h: 1, order } });
  const ops = [A.make('n', 'note.create', { title: 'x' }), pg('p1', 1), pg('p3', 3), pg('p2', 2), A.make('n', 'page.delete', { pageId: 'p3' })];
  assert.deepEqual(pagesOf(buildNote('n', ops)).map((p) => p.id), ['p1', 'p2']);
});
