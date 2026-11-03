import test from 'node:test';
import assert from 'node:assert/strict';
import { _test } from '../js/goodnotes.js';
import { widthAt } from '../js/model.js';
const { strokeLine, fillStroke, bv41 } = _test;
const real = (b64) => bv41(new Uint8Array(Buffer.from(b64, 'base64')));
// 実物(GoodNotes で書いた見本 sample2.goodnotes から、圧縮されたままの線のデータ)
const REAL_PENCIL = 'YnY0MTUFAACvAwAA8AR0cGwANQUAAHZ1QSh2KUEoUyh1AQAWKQsAAgIABBEAAAgABCgAAAwAAjAAAAoAsHUpAAEAH4/HPxsAAQAfAQIAIvIVAAAdV5JCJsUuQ4mwDD/JZ/4+AACAPxoAAABni6zleCeQQlyDHABATmIAPxwAYrMEkEJFfxQAIkx8FACiHNMu/DXsj0JkfBgAIkqWGABTnkSQQpBAACKllxQAonpH5e8InZBCu4osACL/mBgAYqWhlEIl3hQAIr+oFACxH7tOpkKmmEKPMS+gACJ/uBgAYvXjnkJKkhQAE6YUAKKjMVWsqCGlQgTzGAATzhgAcejBrUI+CzBAABPSFACiufmCJyditkJ4IxgAE9YYAGKOcMBCTsdAAAQUAKLeBHs99H7KQiRrGAAT1ywAarAg1EL/LhQAoqv+t3Ftwt1C2vLIAAQsAGrSZ+dC1uwUAKr+kS2TNg3xQtLmGABqujX7Qn7tFACqmho6jh+vAkMq9BgAYjLRB0NiA4QAMVxjAqABooQAnw9F8wxDmxIYADHjDQQYAGJCJRJDIBQUADENjwYUAKIzHTmOPlcXQ6YVGAAxNxAJGABiaLYcQ2zxbAAxItcLFACi0WCyopIVIkMzzRgAMQ+eDhgAYoSAJ0MGuxQAMbQjERQAojEYjqd16yxD2agYADFYqRMYAGKo/C9DCKcUADFqEBUUAKLAqa803A0zQzalGAAxencWGABT4WU6Q4QcATGEthkUAKJtnlHg5r1BQ9EnsAAxlPUcGABixn5MQzyxFAAxZrAgFACxA++v56Y/V0OoOjDcAjExayQYAGL8kmFD+H4UADHxHycUAKJKWmEzUuZrQ0jDGAAxsNQpGABx+Hp1Qxs5MUAAMYD3KxQAouNUTSueD39D7q4YADFPGi4YAHF29oFDbiIyLAAxyVkvFACi+MlcXR5lhEPtlRgAMUKZMBgAcRzYhUPkFTMsADH2NTEUAKI2HdktGkuHQ9uVGAAiqtIYAHGQ7YhDyg80LAAxmlAyLACikPDTwweQikO4iRgAIorOGABijNGLQ9jIFAAx6D4zLACxIIF/YxATjUP4BzVEACJFrxgAYlj3jUOYZRQAMU8jNCwAom494sOg245DN8MYACJZlxgAcb+Gj0NOXjZAADEyGzUsAKKzz9vp3jGQQ2T5GAAiC58YAHH4P5BDhR43LAAiM90UAKIFE5GVslOQQ3ZSGAAxWxs2RABi1tyPQwFFFACAV102P83MDD/MBAcCAFAAAAAAAGJ2NCQ=';
const REAL_EMPTY = 'YnY0MT4AAAAzAAAA8wZ0cGwAPgAAAHZ1QSh2KUEoUyh1dSkIAAAKANd2QShmKQACAB+Pxz8AAQBgAQAAAAAAYnY0JA==';


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

test('先頭に値が1つ多いペン(ペン種別4)も読める(並び順はどちらでも)', () => {
  for (const prefix of [[['u', -1], ['v', 2]], [['v', 2], ['u', -1]]]) {
    const r = strokeLine(pen(prefix));
    assert.ok(r && r.line.length > 1);
    assert.deepEqual(r.line[0].map((x) => +x.toFixed(3)), [10, 20, 1]);
  }
  // 先頭の値が3つ以上、または先頭に並びが来る形は知らない形として扱う
  assert.equal(strokeLine(pen([['v', 2], ['u', -1], ['u', 0]])), null);
  assert.equal(strokeLine(pen([['A(v)', [1]], ['v', 2]])), null);
});

test('実物の鉛筆: 基本の太さで書き、書き終わりで筆圧が下がると細くなる。大学ノートの線にしても太さが戻る', () => {
  const got = strokeLine(real(REAL_PENCIL));
  assert.ok(got.line.length > 100);
  const ws = got.line.map((q) => q[2]);
  assert.equal(+Math.max(...ws).toFixed(3), 1.559);
  assert.ok(ws[ws.length - 1] < 1.2); // 最後の点は筆圧 0.55
  const s = fillStroke({ tool: 'pen', width: 1.6, pr: false, pts: [] }, got);
  assert.equal(s.pr, true);
  for (let i = 0; i < got.line.length; i++) {
    assert.ok(Math.abs(widthAt(s, s.pts[i * 3 + 2]) - got.line[i][2]) < 0.02, `点 ${i} の太さ`);
  }
});

test('鉛筆: 筆圧が 1 を超える値で入っていても、線の中のいちばん強いところを基本の太さにする', () => {
  const raw = tpl([['v', 1], ['u', 2], ['A(v)', [0, 1]], ['A(S(uuuuu))', [0, 0, 3, 1, 4]], ['A(S(uuuuuuuuuuu))', [7, 5, 0, 3, 1, 2, 10, 0, 3, 1, 0]], ['A(S(uu))', []], ['A(v)', []], ['A(S(uu))', []], ['A(S(uuuu))', []], ['A(u)', []]]);
  const ws = strokeLine(raw).line.map((q) => q[2]);
  assert.equal(ws[0], 2);
  assert.ok(ws[Math.floor(ws.length / 2)] < 2 && ws[Math.floor(ws.length / 2)] > 0.6);
});

test('一定の太さの線は筆圧なしのまま', () => {
  const s = fillStroke({ tool: 'pen', width: 1.6, pr: false, pts: [] }, { line: [[0, 0, 1], [5, 5, 1]], width: 0 });
  assert.equal(s.pr, false);
  assert.equal(s.width, 1);
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
  assert.deepEqual(strokeLine(real(REAL_EMPTY)), { empty: true });
  assert.deepEqual(strokeLine(tpl([['v', 2], ['A(v)', []], ['A(u)', []], ['A(u)', []], ['A(v)', []]])), { empty: true });
  assert.deepEqual(strokeLine(tpl([['v', 2], ['u', 1.5], ['A(v)', []], ['A(S(uu))', []], ['A(S(uuuu))', []], ['v', 1], ['A(f)', []]])), { empty: true });
});

test('形は分かったのに読めない線は bad(輪郭だけある線など)', () => {
  assert.deepEqual(strokeLine(tpl([['v', 2], ['A(v)', []], ['A(u)', []], ['A(u)', []], ['A(v)', [1]]])), { bad: true });
  assert.deepEqual(strokeLine(tpl([['v', 2], ['A(v)', [0, 1]], ['A(u)', [1, 2, 3]], ['A(u)', [1, 2]]])), { bad: true });
});

test('知らない形は null', () => {
  assert.equal(strokeLine(tpl([['v', 2], ['A(u)', [1, 2]]])), null);
});
