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
