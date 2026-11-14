// 本物の同期の仕組み(js/webdav.js)を、同期サーバー(server/)に向けて動かすテスト。
// 2台の端末がメールでログインし、パスワードに鍵を入れた Basic(今のアプリのまま)でつないで、
// 変更・PDF を送り合えることを確かめる。ETag で変わっていないフォルダを見ないことも確かめる。
//
// js/webdav.js はブラウザ用なので、足りないもの(IndexedDB・DOMParser・document)を代わりのもので埋める:
//   IndexedDB → test/fake-db.mjs(端末ごとに別の中身。test/webdav-hooks.mjs で差し替える)
//   DOMParser → test/fake-dom.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import worker from '../server/src/index.js';
import { Recorder } from '../js/model.js';
import { DOMParser } from './fake-dom.mjs';
import { fakeEnv, startWorker, captureMail } from './cf-fakes.mjs';

register('./webdav-hooks.mjs', import.meta.url);
globalThis.DOMParser = DOMParser;
globalThis.document = { visibilityState: 'visible', addEventListener() {} };
globalThis.window = { addEventListener() {} };

let env, srv, mail;
before(async () => {
  env = fakeEnv({ OTP_BURST_SECONDS: '0' });
  srv = await startWorker(worker, env);
  mail = captureMail();
});
after(async () => {
  mail.restore();
  await srv.close();
});

async function login(email, label) {
  const post = (p, body) => fetch(srv.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  await post('/otp/send', { email });
  const v = await post('/otp/verify', { email, code: mail.lastCode(email), label });
  assert.ok(v.token, JSON.stringify(v));
  return v;
}

// 1台の端末。js/webdav.js を端末ごとに別のものとして読み込み、その端末だけの保存先(fake-db)を持つ
let seq = 0;
async function device(id) {
  const q = `dev=${id}-${++seq}`;
  const dav = await import(`../js/webdav.js?${q}`);
  const db = await import(`./fake-db.mjs?${q}`);
  const rec = new Recorder(id);
  const statuses = [];
  const changed = [];
  // init の1分ごとの同期の見張りがテストの終わりを止めないように
  const setIntervalReal = globalThis.setInterval;
  globalThis.setInterval = (...a) => setIntervalReal(...a).unref();
  try {
    await dav.init({ recorder: rec, onRemoteChange: (s) => changed.push(...s), onStatus: (s) => statuses.push(s) });
  } finally {
    globalThis.setInterval = setIntervalReal;
  }
  const d = {
    id, dav, db, rec, statuses, changed,
    status: () => statuses.at(-1),
    async connect(account) {
      // 今のアプリの設定画面と同じ: URL・ユーザー名・パスワード(ここに鍵)
      await dav.configure({ url: account.dav, user: account.email, pass: account.token, auto: false });
    },
    async write(n, t, p) {
      const op = rec.make(n, t, p);
      await db.putOps([op], rec.clock);
      return op;
    },
    // 失敗の詳細(console.warn・error)はテストの出力に出さず、logs に取っておく(結果は同期の表示で確かめる)
    logs: [],
    async sync(manual = true) {
      const { warn, error } = console;
      console.warn = console.error = (...a) => d.logs.push(a.map(String).join(' '));
      try {
        await dav.syncNow(manual);
      } finally {
        Object.assign(console, { warn, error });
      }
      return d.status();
    },
    ids: async () => new Set((await db.allOps()).map((o) => o.id)),
    state: () => db.getMeta('davState'),
  };
  return d;
}

const pts = (n, seed = 1) => Array.from({ length: n * 3 }, (_, i) => Math.round(((i * 37 + seed) % 500) * 100) / 100);
const PDF = new Uint8Array(5000).map((_, i) => (i * 7) % 256);
const PDF_HASH = 'a1'.repeat(32);
const ok = (s) => { assert.match(s, /同期しました/, s); assert.doesNotMatch(s, /失敗|送れませんでした/, s); };
// サーバーに届いた要求のうち、この中で行ったもの
async function requests(fn) {
  const from = srv.log.length;
  await fn();
  return srv.log.slice(from).map((r) => `${r.method} ${r.path}`);
}

test('2台の端末が、メールのログインだけで変更と PDF を送り合える', async () => {
  const accA = await login('student@example.com', 'iPad');
  const accB = await login('student@example.com', 'PC');
  assert.equal(accA.userId, accB.userId);
  const A = await device('aaaa1111');
  const B = await device('bbbb2222');
  await A.connect(accA);
  await B.connect(accB);

  // A: ノートを作り、PDF のページと線を書く
  await A.db.putFile({ hash: PDF_HASH, name: 'lecture.pdf', type: 'application/pdf', data: new Blob([PDF], { type: 'application/pdf' }) });
  await A.write('n1', 'note.create', { title: '線形代数' });
  await A.write('n1', 'page.add', { page: { id: 'p1', bg: { type: 'pdf', hash: PDF_HASH, page: 1 } } });
  await A.write('n1', 'stroke.add', { page: 'p1', s: { id: 's1', tool: 'pen', pts: pts(50), color: '#000', width: 2 } });
  ok(await A.sync());
  assert.match(A.status(), /送信 3件/);
  // サーバーには1つの変更のファイルと PDF
  assert.equal(env.DB.q('SELECT COUNT(*) AS n FROM op_files WHERE device = ?', 'aaaa1111')[0].n, 1);
  assert.ok(env.FILES.objects.has(`u/${accA.userId}/files/${PDF_HASH}.pdf`));

  // B: 受け取る
  ok(await B.sync());
  assert.match(B.status(), /受信 3件/);
  assert.deepEqual(await B.ids(), await A.ids());
  assert.deepEqual(B.changed, ['n1']);
  const f = await B.db.getFile(PDF_HASH);
  assert.ok(f, 'PDF が届いていない');
  assert.deepEqual(new Uint8Array(await f.data.arrayBuffer()), PDF);

  // B が書き足し、A が(手動ではない)同期で受け取る
  await B.write('n1', 'stroke.add', { page: 'p1', s: { id: 's2', tool: 'pen', pts: pts(20, 2), color: '#f00', width: 2 } });
  await B.write('n1', 'note.rename', { title: '線形代数 第2回' });
  ok(await B.sync());
  ok(await A.sync(false));
  assert.deepEqual(await A.ids(), await B.ids());
  assert.equal((await A.ids()).size, 5);

  // 変わっていないときは、ops/ を1回一覧するだけ(端末のフォルダの中は見ない)
  const quiet = await requests(() => A.sync(false));
  assert.deepEqual(quiet.filter((r) => r.startsWith('PROPFIND')), ['PROPFIND /dav/daigaku-note/ops/']);
  assert.ok(!quiet.some((r) => r.startsWith('GET')));

  // B が書いたら、B のフォルダの ETag が変わり、A は中を見て受け取る
  await B.write('n1', 'stroke.del', { page: 'p1', id: 's1' });
  ok(await B.sync(false));
  const changedReqs = await requests(() => A.sync(false));
  assert.ok(changedReqs.includes('PROPFIND /dav/daigaku-note/ops/bbbb2222/'), changedReqs.join('\n'));
  assert.ok(changedReqs.includes('GET /dav/daigaku-note/ops/bbbb2222/000000003-000000003.json'), changedReqs.join('\n'));
  assert.equal((await A.ids()).size, 6);
  // 全部を見る同期(手動)でも、「ETag は同じなのに新しいファイル」は起きない = このサーバーの ETag は当てになる
  ok(await A.sync(true));
  const st = await A.state();
  assert.ok(!st.etagBad);
  assert.ok(!st.etagSus);
  assert.deepEqual(st.cur, { bbbb2222: 3 });

  // 大きな変更は約500KBずつのファイルに分けて送られ、全部届く
  for (let i = 0; i < 40; i++) await A.write('n1', 'stroke.add', { page: 'p1', s: { id: `big${i}`, tool: 'pen', pts: pts(2000, i), color: '#00f', width: 1 } });
  ok(await A.sync());
  const parts = env.DB.q('SELECT from_n, to_n, bytes FROM op_files WHERE device = ? ORDER BY to_n', 'aaaa1111');
  assert.ok(parts.length >= 3, `分けて送られていない: ${JSON.stringify(parts)}`);
  assert.ok(parts.every((p) => p.bytes < 1_900_000));
  ok(await B.sync(false));
  assert.deepEqual(await B.ids(), await A.ids());
  assert.equal((await B.ids()).size, 46);

  // 3台目(同じ利用者の新しい端末)は、全部を最初から受け取る
  const C = await device('cccc3333');
  await C.connect(await login('student@example.com', 'スマホ'));
  ok(await C.sync());
  assert.deepEqual(await C.ids(), await A.ids());
  assert.ok(await C.db.hasFile(PDF_HASH));
});

test('別の利用者の変更は届かない', async () => {
  const one = await device('dddd4444');
  const two = await device('eeee5555');
  await one.connect(await login('one@example.com'));
  await two.connect(await login('two@example.com'));
  await one.write('x', 'note.create', { title: '秘密のノート' });
  ok(await one.sync());
  ok(await two.sync());
  assert.equal((await two.ids()).size, 0);
  assert.match(two.status(), /受信 0件/);
});

test('外された端末の鍵では同期できない(「パスワードが違います」と出る)', async () => {
  const accA = await login('revoke@example.com');
  const accB = await login('revoke@example.com');
  const A = await device('ffff6666');
  await A.connect(accA);
  await A.write('r', 'note.create', { title: 'a' });
  ok(await A.sync());
  const del = await fetch(`${srv.url}/devices?id=${accA.deviceId}`, { method: 'DELETE', headers: { authorization: `Bearer ${accB.token}` } });
  assert.equal(del.status, 200);
  await A.write('r', 'note.rename', { title: 'b' });
  assert.match(await A.sync(), /失敗.*パスワードが違います/);
});

test('PDF が大きすぎる(413)なら変更だけ送る。容量がいっぱい(507)なら送らずに待ち、空いたら送る', async () => {
  const qEnv = fakeEnv({ QUOTA_BYTES: '200000', MAX_FILE_BYTES: '4000', OTP_BURST_SECONDS: '0' });
  const s2 = await startWorker(worker, qEnv);
  try {
    const post = (p, body) => fetch(s2.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const loginSmall = async () => {
      await post('/otp/send', { email: 'small@example.com' });
      const acc = await post('/otp/verify', { email: 'small@example.com', code: mail.lastCode('small@example.com') });
      assert.ok(acc.token, JSON.stringify(acc));
      return acc;
    };
    const A = await device('gggg7777');
    const B = await device('hhhh8888');
    await A.connect(await loginSmall());
    await B.connect(await loginSmall());

    // 5000 バイトの PDF は上限(4000)を超える: 送れなかったと出るが、変更は届く
    await A.db.putFile({ hash: PDF_HASH, name: 'big.pdf', type: 'application/pdf', data: new Blob([PDF], { type: 'application/pdf' }) });
    await A.write('q', 'note.create', { title: '大きい PDF' });
    await A.write('q', 'page.add', { page: { id: 'p', bg: { type: 'pdf', hash: PDF_HASH, page: 1 } } });
    const s = await A.sync();
    assert.match(s, /同期しました/);
    assert.match(s, /PDF・画像のうち 1 個はサーバーに送れませんでした/);
    assert.equal(qEnv.DB.q('SELECT COUNT(*) AS n FROM op_files')[0].n, 1);
    await B.sync();
    assert.equal((await B.ids()).size, 2);

    // 容量いっぱい: 変更のファイルが 507 で断られる。送れなかったと出て、次の同期でもう一度送る
    qEnv.QUOTA_BYTES = String(qEnv.DB.q('SELECT bytes_used FROM users')[0].bytes_used + 10);
    await A.write('q', 'note.rename', { title: '容量いっぱい' });
    const full = await A.sync();
    assert.match(full, /この端末の変更を送れませんでした.*507/);
    assert.equal((await A.state()).sentC, 2);
    qEnv.QUOTA_BYTES = '200000';
    const after = await A.sync();
    assert.match(after, /同期しました/); // 大きすぎた PDF の知らせは、送れるまで出たまま
    assert.doesNotMatch(after, /変更を送れませんでした/);
    assert.equal((await A.state()).sentC, 3);
    await B.sync();
    assert.equal((await B.ids()).size, 3);
  } finally {
    await s2.close();
  }
});

test('大学ノートアカウント(js/account.js)でログインした端末: 変更のあとの待ちは約20秒、閉じるときはすぐ送る、ログイン切れ・容量の知らせ', async () => {
  const storage = new Map([['daigaku-note.api', srv.url]]);
  globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null };
  const account = await import('../js/account.js');
  try {
    assert.equal(account.apiBase(), srv.url);
    const email = 'app@example.com';
    await account.sendCode(email);
    const r = await account.verify(email, mail.lastCode(email));
    assert.equal(r.dav, srv.url + '/dav/');
    await assert.rejects(account.verify(email, '000000'), (e) => e.status === 400 && /番号/.test(e.message));

    const A = await device('acct1111');
    // アプリのログインの画面と同じ設定(ユーザー名は利用者の ID)
    await A.dav.configure({ url: r.dav, user: r.userId, pass: r.token, auto: true, account: { email: r.email, deviceId: r.deviceId } });
    assert.equal(A.dav._test.debounce(), 20_000);
    await A.write('m', 'note.create', { title: 'アカウントのノート' });
    A.dav.schedule(); // 書いたあと: 20秒待つ
    assert.equal(env.DB.q('SELECT COUNT(*) AS n FROM op_files WHERE device = ?', 'acct1111')[0].n, 0);
    await A.dav.flush(); // ノートを閉じた・画面を離れた: すぐ送る
    assert.equal(env.DB.q('SELECT COUNT(*) AS n FROM op_files WHERE device = ?', 'acct1111')[0].n, 1);
    ok(A.status());
    const n = srv.log.length;
    await A.dav.flush(); // 待っているものがなければ何もしない
    assert.equal(srv.log.length, n);

    // WebDAV で同期している端末は今までどおり(4秒、flush は何もしない)
    const W = await device('webdav11');
    await W.connect(await login('webdav-user@example.com'));
    assert.equal(W.dav._test.debounce(), 4000);

    // 端末の一覧・ほかの端末を外す
    const r2 = await account.verify(email, await (async () => { await account.sendCode(email); return mail.lastCode(email); })());
    const list = await account.devices(r2.token);
    assert.equal(list.length, 2);
    assert.deepEqual(list.filter((d) => d.current).map((d) => d.id), [r2.deviceId]);
    assert.equal((await account.me(r2.token)).email, email);

    // 容量いっぱい: 「容量の上限(1GB)」と出る
    env.QUOTA_BYTES = '1';
    await A.write('m', 'note.rename', { title: 'いっぱい' });
    assert.match(await A.sync(), /容量の上限\(1GB\)に達したため、この端末の変更を送れませんでした/);
    delete env.QUOTA_BYTES;

    // 外されたら「ログインが切れました」と出し、authExpired() が true になる(ログインし直すまで)
    await account.revoke(r2.token, r.deviceId);
    assert.match(await A.sync(), /ログインが切れました。もう一度ログインしてください/);
    assert.equal(A.dav.authExpired(), true);
    await A.dav.configure({ url: r2.dav, user: r2.userId, pass: r2.token, auto: false, account: { email, deviceId: r2.deviceId } });
    assert.equal(A.dav.authExpired(), false);
    ok(await A.sync());

    // ログアウト・アカウントの削除
    await account.logout(r2.token);
    await assert.rejects(account.me(r2.token), (e) => e.status === 401);
    const r3 = await account.verify(email, await (async () => { await account.sendCode(email); return mail.lastCode(email); })());
    await account.deleteAccount(r3.token);
    await assert.rejects(account.me(r3.token), (e) => e.status === 401);
  } finally {
    delete globalThis.localStorage;
  }
});
