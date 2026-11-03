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

test('送り直しは、以前の版で GoodNotes を取り込んだ端末だけが、取り込んだノートの最初の番号から一度だけ', () => {
  const { planSend } = _test;
  const op = (c, n, src) => ({ c, n, t: src ? 'stroke.add' : 'note.create', p: src ? { s: { src } } : {} });
  const own = [op(1, 'a'), op(2, 'a', 'pen'), op(3, 'g'), op(4, 'g', 'goodnotes'), op(5, 'g', 'goodnotes'), op(6, 'a', 'pen'), op(7, 'a', 'pen')];
  const fresh = own.slice(6);
  // 以前の版から更新した端末(6 番まで送り済み)。取り込んだノート g の最初(3 番)から送り直す
  let p = planSend(own, fresh, { sentC: 6 });
  assert.deepEqual([p.from, p.to, p.resend, p.out.map((o) => o.c)], [3, 7, true, [3, 4, 5, 6, 7]]);
  // 送り直し済み: ふつうに続きだけ
  p = planSend(own, fresh, { sentC: 6, resent: true });
  assert.deepEqual([p.from, p.to, p.resend, p.out.map((o) => o.c)], [7, 7, false, [7]]);
  // 取り込んでいない端末は送り直さない
  const plain = [op(1, 'a'), op(2, 'a', 'pen'), op(3, 'a', 'pen')];
  p = planSend(plain, plain.slice(2), { sentC: 2 });
  assert.deepEqual([p.from, p.resend], [3, false]);
  // 送るものがなければ何もしない
  assert.equal(planSend(own, [], { sentC: 7 }), null);
});
