import test from 'node:test';
import assert from 'node:assert/strict';
import { _test } from '../js/goodnotes.js';
const { strokeLine } = _test;

// tpl 形式の線のデータを作る。parts = [['v', 2], ['u', 1.5], ['A(v)', [0, 1]], ['A(u)', [...]], ...]
function tpl(parts) {
  const sig = parts.map((p) => p[0]).join('');
  const body = [];
  const u16 = (n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); body.push(...b); };
  const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); body.push(...b); };
  const f32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, n, true); body.push(...b); };
  for (const [t, v] of parts) {
    if (t === 'v') u16(v);
    else if (t === 'u') f32(v);
    else {
      const inner = t.replace(/^A\(|\)$/g, '').replace(/^S\(|\)$/g, '');
      const per = inner === 'v' ? 1 : inner.length;
      u32(v.length / per);
      for (const x of v) (inner === 'v' ? u16 : f32)(x);
    }
  }
  const head = [...'tpl'].map((c) => c.charCodeAt(0));
  const out = new Uint8Array(8 + sig.length + 1 + body.length);
  out.set(head, 0);
  out.set([...sig].map((c) => c.charCodeAt(0)), 8);
  out.set(body, 8 + sig.length + 1);
  return out;
}

const pen = (prefix) => tpl([...prefix, ['A(v)', [0, 1]], ['A(u)', [10, 20, 0.5]], ['A(u)', [15, 20, 0.6, 20, 20, 0.7]], ['A(v)', []], ['A(v)', []], ['A(u)', []], ['A(u)', []], ['A(u)', []], ['A(u)', []], ['A(v)', []]]);

test('ふつうのペン: 半径の2倍を太さにする', () => {
  const r = strokeLine(pen([['v', 2]]));
  assert.equal(r.width, 0);
  assert.deepEqual(r.line[0].map((x) => +x.toFixed(3)), [10, 20, 1]);
  const last = r.line[r.line.length - 1];
  assert.deepEqual(last.map((x) => +x.toFixed(3)), [20, 20, 1.4]);
});

test('先頭に値が1つ多いペン(ペン種別4)も読める', () => {
  const r = strokeLine(pen([['u', -1], ['v', 2]]));
  assert.ok(r && r.line.length > 1);
  assert.deepEqual(r.line[0].map((x) => +x.toFixed(3)), [10, 20, 1]);
});

test('鉛筆: 太さは基本の太さ、筆圧で細くなる(方位角を太さと読まない)', () => {
  // 点 = (x, y, 方位角, 傾き, 筆圧)、区間 = (ID, 制御点5個, 終点5個)
  const raw = tpl([['v', 1], ['u', 2], ['A(v)', [0, 1]], ['A(S(uuuuu))', [0, 0, 3, 1, 1]], ['A(S(uuuuuuuuuuu))', [7, 5, 0, 3, 1, 1, 10, 0, 3, 1, 0]], ['A(S(uu))', []], ['A(v)', []], ['A(S(uu))', []], ['A(S(uuuu))', []], ['A(u)', []]]);
  const r = strokeLine(raw);
  assert.equal(r.line[0][2], 2); // 筆圧1 → 基本の太さ
  const last = r.line[r.line.length - 1];
  assert.equal(+last[0].toFixed(3), 10);
  assert.equal(+last[2].toFixed(3), 0.6); // 筆圧0 → 0.3倍
});

test('蛍光ペンなど: 太さは線全体で一定', () => {
  const raw = tpl([['v', 2], ['u', 24], ['A(v)', [0, 1]], ['A(S(uu))', [0, 0]], ['A(S(uuuu))', [5, 0, 10, 0]], ['v', 1], ['A(f)', []]]);
  const r = strokeLine(raw);
  assert.equal(r.width, 24);
  assert.ok(r.line.every((q) => q[2] === 24));
});

test('点のない線は「空」として返す(座標らしい値を探しに行かない)', () => {
  assert.deepEqual(strokeLine(tpl([['v', 2], ['A(v)', []], ['A(u)', []], ['A(u)', []], ['A(v)', []]])), { empty: true });
  assert.deepEqual(strokeLine(tpl([['v', 2], ['u', 1.5], ['A(v)', []], ['A(S(uu))', []], ['A(S(uuuu))', []], ['v', 1], ['A(f)', []]])), { empty: true });
});

test('知らない形は null', () => {
  assert.equal(strokeLine(tpl([['v', 2], ['A(u)', [1, 2]]])), null);
});
