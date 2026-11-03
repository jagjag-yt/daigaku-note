import test from 'node:test';
import assert from 'node:assert/strict';
import { _test } from '../js/webdav.js';
const { migrate, endOf } = _test;

test('ファイル名から終了番号を読む', () => {
  assert.equal(endOf('000000001-000000042.json'), 42);
  assert.equal(endOf('a.json'), null);
  assert.equal(endOf('000000001-000000042.json.part'), null);
});

test('以前の版の「読んだファイルの一覧」を端末ごとのカーソルにする', () => {
  const st = migrate({ key: 'k', sentC: 3, seen: ['ops/aa/000000001-000000010.json', 'ops/aa/000000011-000000012.json', 'ops/bb/000000001-000000500.json', 'ops/bb/000000400-000000450.json', 'ops/cc/x.json'], sentFiles: [] });
  assert.deepEqual(st.cur, { aa: 12, bb: 500 });
  assert.deepEqual(st.tags, {});
  assert.equal(st.seen, undefined);
  assert.equal(st.sentC, 3);
});

test('自分の op は、送り済みの続きから抜けなく並んでいるところまで送る', () => {
  const { unsent } = _test;
  const ops = (...cs) => cs.map((c) => ({ c }));
  // 取り込みの途中で 3〜4 番がまだ保存されていない: 2 番までしか送らない
  let r = unsent(ops(1, 2, 5, 6), 0);
  assert.deepEqual(r.fresh.map((o) => o.c), [1, 2]);
  assert.deepEqual(r.pending.map((o) => o.c), [1, 2, 5, 6]);
  r = unsent(ops(1, 2, 3, 4, 5), 2);
  assert.deepEqual(r.fresh.map((o) => o.c), [3, 4, 5]);
  r = unsent(ops(1, 2, 5), 2);
  assert.deepEqual(r.fresh, []);
  assert.deepEqual(r.pending.map((o) => o.c), [5]);
});
