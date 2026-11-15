// ペン先の種類・破線/点線・鉛筆(js/model.js の widthAt、js/ink.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { widthAt } from '../js/model.js';
import { variableWidth, dashArray, strokeSvg, geometry } from '../js/ink.js';

const base = { tool: 'pen', color: '#000', width: 2, pr: 2, sm: 1, pts: [0, 0, 0.2, 10, 0, 0.5, 20, 0, 0.9] };

test('筆ペンは万年筆より筆圧の差が大きく、鉛筆は小さい', () => {
  const range = (d) => widthAt(d, 1) - widthAt(d, 0);
  const fountain = range(base), brush = range({ ...base, nib: 'brush' }), pencil = range({ ...base, nib: 'pencil' });
  assert.ok(brush > fountain, `${brush} > ${fountain}`);
  assert.ok(pencil < fountain, `${pencil} < ${fountain}`);
});

test('万年筆(nib なし)の太さは今までと同じ', () => {
  assert.equal(widthAt(base, 0.25), 2 * (0.55 + 0.6 * 0.5));
});

test('破線・点線・ボールペンは太さ一定の線(なぞる線)になる', () => {
  assert.ok(variableWidth(base));
  assert.ok(!variableWidth({ ...base, dash: 'dash' }));
  assert.ok(!variableWidth({ ...base, nib: 'ball' }));
  assert.equal(geometry({ ...base, dash: 'dot' }).kind, 'stroke');
});

test('破線は SVG に間隔が付き、実線には付かない。鉛筆は class が付く', () => {
  const d = { ...base, dash: 'dash' };
  assert.match(strokeSvg('a', d, geometry(d)), /stroke-dasharray="6 4\.4"/);
  assert.doesNotMatch(strokeSvg('a', { ...base, pr: false }, geometry({ ...base, pr: false })), /dasharray/);
  assert.deepEqual(dashArray({ dash: 'dot', width: 2 }), [0.001, 4]);
  const p = { ...base, nib: 'pencil' };
  assert.match(strokeSvg('a', p, geometry(p)), /class="pencil"/);
});

test('ふつうの筆圧(0.2)では、筆ペンも万年筆とほぼ同じ太さ', () => {
  const f = widthAt(base, 0.2), b = widthAt({ ...base, nib: 'brush' }, 0.2);
  assert.ok(Math.abs(f - b) / f < 0.05, `${f} ≒ ${b}`);
});
