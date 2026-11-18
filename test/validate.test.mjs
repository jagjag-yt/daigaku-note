// 外から届いた op の確かめ(js/validate.js)。他人のノートに仕込まれた値で、スクリプトを動かされないこと。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanOp, cleanOps } from '../js/validate.js';
import { buildNote } from '../js/model.js';
import { strokeSvg, geometry } from '../js/ink.js';

const base = (t, p, n = 'note1') => ({ id: 'dev1:1', d: 'dev1', c: 1, l: 1, ts: 1, n, t, p });
const EVIL = 'red"><img src=x onerror=alert(1)>';

test('表紙の色に細工した note.create は、色だけを外して残す', () => {
  const op = cleanOp(base('note.create', { title: 'a', cover: EVIL }));
  assert.equal(op.p.cover, undefined);
  assert.equal(op.p.title, 'a');
  assert.equal(cleanOp(base('note.cover', { cover: EVIL })), null);
  assert.equal(cleanOp(base('note.cover', { cover: '#2f5d9e' })).p.cover, '#2f5d9e');
});

test('ID の形が違う op は捨てる', () => {
  assert.equal(cleanOp(base('note.create', { title: 'a' }, 'x" onmouseover="1')), null);
  assert.equal(cleanOp({ ...base('note.create', { title: 'a' }), d: '../x' }), null);
  assert.equal(cleanOp(base('page.delete', { pageId: '<b>' })), null);
  assert.equal(cleanOp(base('note.move', { folder: 'a b' })), null);
  assert.equal(cleanOp(null), null);
  assert.equal(cleanOp({ ...base('note.create', {}), l: 'x' }), null);
  assert.deepEqual(cleanOps('x'), []);
});

test('線の色・太さ・ID に細工しても、SVG の属性からはみ出さない', () => {
  const op = cleanOp(base('stroke.add', { s: { id: 's1', pageId: 'p1', tool: 'pen', color: EVIL, width: '2" onload="x', pts: [0, 0, 0.5, 10, 10, 0.5] } }));
  assert.equal(op.p.s.color, '#000000');
  assert.equal(op.p.s.width, 1);
  // 確かめる前の値を直接描いても(念のため)、属性の外に出ない
  const svg = strokeSvg('a"><script>', { tool: 'pen', color: EVIL, width: 2, pts: [0, 0, 0.5, 10, 10, 0.5] }, { kind: 'stroke', d: 'M0 0', w: '1" onload="x' }, ['1" x="', 0]);
  assert.ok(!/<img|<script| x="| onload="/.test(svg), svg);
  assert.equal(svg.split('"').length % 2, 1, svg); // 引用符の対がそろっている
  assert.equal(cleanOp(base('stroke.add', { s: { id: 's1', pageId: 'p1', pts: 'x' } })), null);
  assert.equal(cleanOp(base('item.add', { s: { id: 'i1', pageId: 'p1', tool: 'image', hash: 'nothex', pts: [] } })), null);
  const img = cleanOp(base('item.add', { s: { id: 'i1', pageId: 'p1', tool: 'image', hash: 'a'.repeat(64), mime: 'text/html', pts: [] } }));
  assert.equal(img.p.s.mime, undefined);
});

test('ふつうのアプリが作る op はそのまま通る', () => {
  const ops = [
    base('note.create', { title: '線形代数', cover: '#2f5d9e', folder: 'f1' }),
    base('page.add', { page: { id: 'p1', w: 595.28, h: 841.89, order: 1, bg: { type: 'blank', ruling: 'lines-b', paper: 'cream' } } }),
    base('page.add', { page: { id: 'p2', w: 595.28, h: 841.89, order: 2, bg: { type: 'pdf', hash: 'b'.repeat(64), page: 1, tpl: 't1' } } }),
    base('stroke.add', { s: { id: 's1', pageId: 'p1', tool: 'marker', color: '#fde047', width: 12, pr: false, pts: [1, 2, 0.5] } }),
    base('item.add', { s: { id: 'i1', pageId: 'p1', tool: 'text', text: 'こんにちは', size: 16, font: 'gothic', color: '#1f2937', fill: '#fef08a', border: { w: 1, color: '#374151' }, pts: [0, 0, 0, 100, 100, 0] } }),
    base('stroke.tf', { tf: { s1: [10, -5] } }),
    base('stroke.style', { styles: { s1: { color: '#dc2626' }, i1: { color: null } } }),
    base('stroke.del', { ids: ['s1'] }),
    base('page.title', { pageId: 'p1', title: '第1回' }),
    base('page.move', { pageId: 'p2', order: 0.5 }),
    base('page.bg', { pageId: 'p1', bg: { type: 'blank', ruling: 'grid' } }),
    base('tpl.add', { name: 'A4', hash: 'c'.repeat(64), page: 1, w: 595, h: 842 }, 't1'),
    base('note.lock', { lock: true }),
    base('future.thing', { anything: 1 }),
  ];
  const out = cleanOps(ops);
  assert.equal(out.length, ops.length);
  assert.deepEqual(out, ops);
  // 確かめたあとの op で、ノートを組み立てられる
  const note = buildNote('note1', out.filter((o) => o.n === 'note1'));
  assert.equal(note.cover, '#2f5d9e');
});
