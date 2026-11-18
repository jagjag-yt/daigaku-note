// 同期サーバー(server/)のテスト: ログイン・端末・CORS・WebDAV のまね・容量。
// D1 は本物の SQLite(node:sqlite)、R2 はメモリ上の代わり(test/cf-fakes.mjs)。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import worker, { cleanup } from '../server/src/index.js';
import { parseDavPath } from '../server/src/dav.js';
import { fakeEnv, startWorker, captureMail } from './cf-fakes.mjs';
import { couponHash, newCouponCode, normalizeCoupon } from '../server/src/coupon.js';

const ORIGIN = 'https://jagjag-yt.github.io';
let env, srv, mail;

// サーバーのログ(メールの送信の失敗など、わざと起こすもの)はテストの出力に出さない
const logs = [];
const consoleLog = console.log;
before(async () => {
  console.log = (...a) => logs.push(a.map(String).join(' '));
  env = fakeEnv({ OTP_BURST_SECONDS: '0' });
  srv = await startWorker(worker, env);
  mail = captureMail();
});
after(async () => {
  console.log = consoleLog;
  mail.restore();
  await srv.close();
});

const call = (path, { method = 'GET', body, token, headers = {} } = {}) => fetch(srv.url + path, {
  method,
  headers: {
    ...(body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...headers,
  },
  body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
});
const api = async (path, opts) => {
  const res = await call(path, opts);
  return { status: res.status, data: await res.json().catch(() => null), res };
};
const basic = (token, user = 'token') => 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');

async function login(email, label) {
  const s = await api('/otp/send', { method: 'POST', body: { email } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const v = await api('/otp/verify', { method: 'POST', body: { email, code: mail.lastCode(email), label } });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return v.data;
}

// PROPFIND の応答から { 名前(href): ETag } を取り出す(テスト用の雑な読み方)
async function propfind(token, path, depth = '1') {
  const res = await call(path, { method: 'PROPFIND', token, headers: { depth, 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>' });
  const text = await res.text();
  const items = {};
  for (const m of text.matchAll(/<d:response><d:href>([^<]*)<\/d:href>[\s\S]*?<d:getetag>([^<]*)<\/d:getetag>/g)) items[m[1]] = m[2];
  return { status: res.status, items, text, res };
}

test('/health は版を返す', async () => {
  const r = await api('/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.match(r.data.version, /\d{4}-\d{2}-\d{2}/);
});

test('CORS: 許可した呼び出し元だけに、PROPFIND・MKCOL と Authorization・Depth を許し、ETag を見せる', async () => {
  const pre = await call('/dav/daigaku-note/ops/', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'PROPFIND', 'access-control-request-headers': 'authorization,depth,content-type' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(pre.headers.get('access-control-allow-methods'), /PROPFIND/);
  assert.match(pre.headers.get('access-control-allow-methods'), /MKCOL/);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
  assert.match(pre.headers.get('access-control-allow-headers'), /depth/);
  for (const o of ['http://localhost:8123', 'capacitor://localhost', 'https://localhost']) {
    const r = await call('/health', { method: 'OPTIONS', headers: { origin: o } });
    assert.equal(r.headers.get('access-control-allow-origin'), o);
  }
  const evil = await call('/dav/', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  // 断るとき(401)にも CORS の見出しを付ける(ブラウザで理由が見えるように)
  const denied = await call('/dav/', { method: 'PROPFIND', headers: { origin: ORIGIN, depth: '1' } });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(denied.headers.get('access-control-expose-headers'), 'etag');
  assert.match(denied.headers.get('www-authenticate'), /^Bearer/); // Basic だとブラウザが入力欄を出す
});

test('ログイン: 番号をメールで送り、確かめたら鍵を渡す。番号は使い捨て', async () => {
  const email = 'Taro@Example.com ';
  const bad = await api('/otp/send', { method: 'POST', body: { email: 'not-an-email' } });
  assert.equal(bad.status, 400);
  const s = await api('/otp/send', { method: 'POST', body: { email } });
  assert.equal(s.status, 200);
  assert.equal(s.data.devCode, undefined); // DEV_ECHO_OTP なしでは返さない
  const m = mail.mails.at(-1);
  assert.deepEqual(m.to, ['taro@example.com']);
  assert.equal(m.from, env.MAIL_FROM);
  assert.equal(m.auth, 'Bearer re_test');
  const code = mail.lastCode('taro@example.com');
  assert.match(code, /^\d{6}$/);
  // 保存しているのはハッシュだけ
  const rows = env.DB.q('SELECT code_hash FROM otp_requests WHERE email = ?', 'taro@example.com');
  assert.ok(rows.length && rows.every((r) => r.code_hash !== code && /^[0-9a-f]{64}$/.test(r.code_hash)));

  const v = await api('/otp/verify', { method: 'POST', body: { email: 'taro@example.com', code, label: 'テストの iPad' } });
  assert.equal(v.status, 200);
  assert.match(v.data.token, /^dn_[0-9a-f]{64}$/);
  assert.equal(v.data.email, 'taro@example.com');
  assert.equal(v.data.deviceLabel, 'テストの iPad');
  assert.equal(v.data.dav, srv.url + '/dav/');
  assert.equal(env.DB.q('SELECT token_hash FROM devices WHERE token_hash = ?', v.data.token).length, 0); // 鍵そのものは保存しない

  const again = await api('/otp/verify', { method: 'POST', body: { email: 'taro@example.com', code } });
  assert.equal(again.status, 400); // 使用済み

  const me = await api('/me', { token: v.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.email, 'taro@example.com');
  assert.equal(me.data.userId, v.data.userId);
  assert.deepEqual(me.data.usage, { bytes: 0, quota: 1024 ** 3 });

  // 2回目のログインは同じ利用者
  const second = await login('taro@example.com');
  assert.equal(second.userId, v.data.userId);
});

test('ログイン: 間違いは5回まで。期限切れ・メールの送信の失敗', async () => {
  const email = 'hanako@example.com';
  await api('/otp/send', { method: 'POST', body: { email } });
  const code = mail.lastCode(email);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const r = await api('/otp/verify', { method: 'POST', body: { email, code: wrong } });
    assert.equal(r.status, 400);
    assert.match(r.data.message, new RegExp(`あと${4 - i}回`));
  }
  // 5回間違えたら、正しい番号でも通らない
  const locked = await api('/otp/verify', { method: 'POST', body: { email, code } });
  assert.equal(locked.status, 429);

  await api('/otp/send', { method: 'POST', body: { email } });
  env.DB.x('UPDATE otp_requests SET expires_at = ? WHERE email = ?', new Date(Date.now() - 1000).toISOString(), email);
  const expired = await api('/otp/verify', { method: 'POST', body: { email, code: mail.lastCode(email) } });
  assert.equal(expired.status, 400);
  assert.match(expired.data.message, /期限/);

  mail.fail = true;
  try {
    const r = await api('/otp/send', { method: 'POST', body: { email } });
    assert.equal(r.status, 502);
  } finally {
    mail.fail = false;
  }
});

test('ログイン: 登録のあるアドレスとないアドレスで、応答は同じ(登録の有無が分からない)', async () => {
  await login('known@example.com');
  const a = await api('/otp/send', { method: 'POST', body: { email: 'known@example.com' } });
  const b = await api('/otp/send', { method: 'POST', body: { email: 'unknown@example.com' } });
  assert.equal(a.status, b.status);
  assert.deepEqual(Object.keys(a.data).sort(), Object.keys(b.data).sort());
  assert.deepEqual(a.data, b.data);
  // 番号を送っただけでは利用者を作らない
  assert.equal(env.DB.q('SELECT 1 FROM users WHERE email = ?', 'unknown@example.com').length, 0);
});

test('ログインとアカウント作成: purpose で文面と扱いが変わる。登録の有無は番号を確かめるまで分からない', async () => {
  const lastMail = (to) => [...mail.mails].reverse().find((m) => m.to.includes(to));
  // メールの文面は purpose だけで決まる(登録の有無では変わらない)
  const sA = await api('/otp/send', { method: 'POST', body: { email: 'new1@example.com', purpose: 'login' } });
  const sB = await api('/otp/send', { method: 'POST', body: { email: 'known@example.com', purpose: 'login' } });
  assert.deepEqual(sA.data, sB.data);
  assert.match(lastMail('new1@example.com').subject, /ログイン番号/);
  assert.equal(lastMail('new1@example.com').subject.replace(/\d+/, ''), lastMail('known@example.com').subject.replace(/\d+/, ''));

  // ログインなのにアカウントがない: 鍵を出さず、利用者も作らない。同じ番号でアカウント作成に切り替えられる
  const code = mail.lastCode('new1@example.com');
  const no = await api('/otp/verify', { method: 'POST', body: { email: 'new1@example.com', code, purpose: 'login' } });
  assert.equal(no.status, 404);
  assert.equal(no.data.reason, 'no_account');
  assert.equal(no.data.token, undefined);
  assert.equal(env.DB.q('SELECT 1 FROM users WHERE email = ?', 'new1@example.com').length, 0);
  const made = await api('/otp/verify', { method: 'POST', body: { email: 'new1@example.com', code, purpose: 'signup' } });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal(made.data.existing, false);
  assert.ok(made.data.token);
  // 使った番号は二度と使えない
  const again = await api('/otp/verify', { method: 'POST', body: { email: 'new1@example.com', code, purpose: 'signup' } });
  assert.equal(again.status, 400);

  // 違う番号では「アカウントがない」とは言わない(番号を知らない人に登録の有無を漏らさない)
  await api('/otp/send', { method: 'POST', body: { email: 'new2@example.com', purpose: 'login' } });
  const right = mail.lastCode('new2@example.com');
  const wrong = right === '000000' ? '111111' : '000000';
  const bad = await api('/otp/verify', { method: 'POST', body: { email: 'new2@example.com', code: wrong, purpose: 'login' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.reason, undefined);

  // 4回間違えたあとに正しい番号を入れても、同じ番号でアカウントを作れる(アカウントがないと知らせた回は数えない)
  await api('/otp/send', { method: 'POST', body: { email: 'new3@example.com', purpose: 'login' } });
  const c3 = mail.lastCode('new3@example.com');
  const w3 = c3 === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.equal((await api('/otp/verify', { method: 'POST', body: { email: 'new3@example.com', code: w3, purpose: 'login' } })).status, 400);
  assert.equal((await api('/otp/verify', { method: 'POST', body: { email: 'new3@example.com', code: c3, purpose: 'login' } })).status, 404);
  const made3 = await api('/otp/verify', { method: 'POST', body: { email: 'new3@example.com', code: c3, purpose: 'signup' } });
  assert.equal(made3.status, 200, JSON.stringify(made3.data));

  // アカウント作成の文面。すでにあるアドレスなら、そのままログインして existing: true
  await api('/otp/send', { method: 'POST', body: { email: 'known@example.com', purpose: 'signup' } });
  assert.match(lastMail('known@example.com').subject, /アカウント作成の確認番号/);
  const ex = await api('/otp/verify', { method: 'POST', body: { email: 'known@example.com', code: mail.lastCode('known@example.com'), purpose: 'signup' } });
  assert.equal(ex.status, 200);
  assert.equal(ex.data.existing, true);
  // ログイン: あるアドレスはふつうにログインできる
  await api('/otp/send', { method: 'POST', body: { email: 'known@example.com', purpose: 'login' } });
  const li = await api('/otp/verify', { method: 'POST', body: { email: 'known@example.com', code: mail.lastCode('known@example.com'), purpose: 'login' } });
  assert.equal(li.status, 200);
  assert.equal(li.data.existing, true);
});

test('ログイン: 他人が同じアドレスへ送り続けても、別の IP の本人は送れる。サービス全体の上限', async () => {
  const e2 = fakeEnv({ OTP_DAILY_LIMIT: '25' });
  const s2 = await startWorker(worker, e2);
  try {
    const send = (email, ip) => fetch(s2.url + '/otp/send', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ email }) });
    e2.OTP_BURST_SECONDS = '0';
    // 攻撃する人: 1つの IP から同じアドレスへ10回まで
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await send('victim@example.com', '203.0.113.50')).status);
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(200));
    assert.equal(codes[10], 429);
    // 本人(別の IP)はまだ送れる
    assert.equal((await send('victim@example.com', '198.51.100.7')).status, 200);
    // サービス全体: 1日25通(ここまで11通)。ほかの上限で断られたものは数えない
    let st;
    for (let i = 0; i < 14; i++) st = (await send(`other${i}@example.com`, `192.0.2.${i}`)).status;
    assert.equal(st, 200);
    const over = await send('late@example.com', '192.0.2.200');
    assert.equal(over.status, 503);
    assert.match((await over.json()).message, /この端末だけで使う/);
  } finally {
    await s2.close();
  }
});

test('ログイン: 送信の回数の上限(続けての送信・IP ごと)', async () => {
  const burstEnv = fakeEnv(); // OTP_BURST_SECONDS なし = 60秒
  const s2 = await startWorker(worker, burstEnv);
  try {
    const send = (email, ip) => fetch(s2.url + '/otp/send', { method: 'POST', headers: { 'content-type': 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}) }, body: JSON.stringify({ email }) });
    assert.equal((await send('burst@example.com')).status, 200);
    const r = await send('burst@example.com');
    assert.equal(r.status, 429);
    assert.match((await r.json()).message, /続けて/);
    // IP ごと: 1時間に20回まで(アドレスを変えても)
    let last;
    for (let i = 0; i < 21; i++) last = await send(`ip${i}@example.com`, '203.0.113.9');
    assert.equal(last.status, 429);
    // 本番(cf-connecting-ip あり)では DEV_ECHO_OTP を入れても番号を返さない
    burstEnv.DEV_ECHO_OTP = '1';
    const echoed = await (await send('echo@example.com')).json();
    assert.match(echoed.devCode, /^\d{6}$/);
    const prod = await (await send('echo2@example.com', '198.51.100.1')).json();
    assert.equal(prod.devCode, undefined);
  } finally {
    await s2.close();
  }
});

test('端末: 5台まで(6台目でいちばん古い端末が外れる)。一覧・外す・ログアウト', async () => {
  const email = 'devices@example.com';
  const tokens = [];
  for (let i = 0; i < 5; i++) {
    const d = await login(email, `端末${i}`);
    assert.equal(d.removedDevices, 0);
    tokens.push(d.token);
    // 使った時刻をずらす(端末0がいちばん古い)
    env.DB.x('UPDATE devices SET last_used_at = ? WHERE id = ?', new Date(Date.now() - (10 - i) * 60_000).toISOString(), d.deviceId);
  }
  const sixth = await login(email, '端末5');
  assert.equal(sixth.removedDevices, 1);
  assert.equal((await api('/me', { token: tokens[0] })).status, 401);
  assert.equal((await api('/me', { token: tokens[1] })).status, 200);

  const list = await api('/devices', { token: sixth.token });
  assert.equal(list.data.devices.length, 5);
  assert.equal(list.data.devices.filter((d) => d.current).length, 1);
  assert.ok(!list.data.devices.some((d) => d.label === '端末0'));

  // 外す: 自分の端末だけ
  const other = await login('stranger@example.com');
  const target = list.data.devices.find((d) => d.label === '端末1');
  assert.equal((await api(`/devices?id=${target.id}`, { method: 'DELETE', token: other.token })).status, 404);
  assert.equal((await api(`/devices?id=${target.id}`, { method: 'DELETE', token: sixth.token })).status, 200);
  assert.equal((await api('/me', { token: tokens[1] })).status, 401);
  // 外した端末は同期の置き場も使えない
  assert.equal((await call('/dav/', { method: 'PROPFIND', token: tokens[1], headers: { depth: '0' } })).status, 401);

  assert.equal((await api('/logout', { method: 'POST', token: tokens[2] })).status, 200);
  assert.equal((await api('/me', { token: tokens[2] })).status, 401);
  // 長く使われていない鍵は無効
  env.DB.x('UPDATE devices SET last_used_at = ? WHERE label = ?', new Date(Date.now() - 200 * 86_400_000).toISOString(), '端末3');
  assert.equal((await api('/me', { token: tokens[3] })).status, 401);
});

test('鍵: Bearer と、パスワードに鍵を入れた Basic のどちらでも通る。形の違う鍵・違う鍵は 401', async () => {
  const { token } = await login('auth@example.com');
  assert.equal((await call('/dav/', { method: 'PROPFIND', token, headers: { depth: '0' } })).status, 207);
  assert.equal((await call('/dav/', { method: 'PROPFIND', headers: { depth: '0', authorization: basic(token) } })).status, 207);
  assert.equal((await call('/dav/', { method: 'PROPFIND', headers: { depth: '0', authorization: basic(token, 'auth@example.com') } })).status, 207);
  for (const h of [basic('dn_' + '0'.repeat(64)), basic('x'), 'Bearer ' + token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'), 'Basic !!!', `Bearer ${token}x`, '']) {
    assert.equal((await call('/dav/', { method: 'PROPFIND', headers: { depth: '0', authorization: h } })).status, 401, h);
  }
});

test('住所の読み解き: 決まった形だけを通す', () => {
  assert.equal(parseDavPath('/me'), null);
  assert.equal(parseDavPath('/davx/'), null);
  assert.equal(parseDavPath('/dav').kind, 'root');
  assert.equal(parseDavPath('/dav/').kind, 'root');
  assert.equal(parseDavPath('/dav/daigaku-note/').kind, 'app');
  assert.equal(parseDavPath('/dav/daigaku-note/ops/').kind, 'ops');
  assert.equal(parseDavPath('/dav/daigaku-note/files/').kind, 'files');
  assert.deepEqual(parseDavPath('/dav/daigaku-note/ops/abc123/'), { kind: 'opdir', device: 'abc123' });
  assert.deepEqual(parseDavPath('/dav/daigaku-note/ops/abc123/000000001-000000042.json'), { kind: 'opfile', device: 'abc123', from: 1, to: 42, name: '000000001-000000042.json' });
  const h = 'a'.repeat(64);
  assert.deepEqual(parseDavPath(`/dav/daigaku-note/files/${h}.pdf`), { kind: 'file', name: `${h}.pdf`, stem: h, ext: 'pdf' });
  for (const p of [
    '/dav/other/', '/dav/daigaku-note/x/', '/dav/daigaku-note/ops/a.b/', '/dav/daigaku-note/ops/../x/', '/dav/daigaku-note/ops/%2e%2e/x/',
    '/dav/daigaku-note/ops/abc/1-2.json', '/dav/daigaku-note/ops/abc/000000002-000000001.json', '/dav/daigaku-note/ops/abc/000000001-000000002.json/',
    '/dav/daigaku-note/ops/abc/x.json', '/dav/daigaku-note/ops/abc/def/000000001-000000002.json', '/dav/daigaku-note/files/../../u/x.pdf',
    `/dav/daigaku-note/files/${h}.exe`, `/dav/daigaku-note/files/${h.toUpperCase()}.pdf`, '/dav/daigaku-note//ops/', '/dav/%E0%A4%A', '/dav/daigaku-note/files/a%5Cb.pdf',
  ]) assert.equal(parseDavPath(p)?.kind, 'bad', p);
});

test('WebDAV: MKCOL・PROPFIND・PUT・GET・HEAD が js/webdav.js の期待どおりに答える', async () => {
  const { token } = await login('dav@example.com');
  const auth = { authorization: basic(token) };
  const req = (method, p, opts = {}) => call('/dav/' + p, { method, ...opts, headers: { ...auth, ...(opts.headers || {}) } });

  // いつもあるフォルダ: 405 =「すでにある」
  for (const p of ['', 'daigaku-note/', 'daigaku-note/ops/', 'daigaku-note/files/']) assert.equal((await req('MKCOL', p)).status, 405, p);
  // 端末のフォルダ: まだないので PROPFIND は 404、MKCOL は 201、2回目は 405
  assert.equal((await propfind(token, '/dav/daigaku-note/ops/dev1/')).status, 404);
  assert.equal((await req('MKCOL', 'daigaku-note/ops/dev1/')).status, 201);
  assert.equal((await req('MKCOL', 'daigaku-note/ops/dev1/')).status, 405);
  // 決まった形でない場所には作れない・置けない
  assert.equal((await req('MKCOL', 'daigaku-note/elsewhere/')).status, 403);
  assert.equal((await req('PUT', 'daigaku-note/ops/dev1/notes.txt', { body: 'x' })).status, 403);
  assert.equal((await req('PUT', 'daigaku-note/ops/', { body: 'x' })).status, 405);

  let ops = await propfind(token, '/dav/daigaku-note/ops/');
  assert.equal(ops.status, 207);
  assert.match(ops.res.headers.get('content-type'), /xml/);
  assert.match(ops.text, /<d:multistatus xmlns:d="DAV:">/);
  assert.ok(ops.items['/dav/daigaku-note/ops/']);
  const tag0 = ops.items['/dav/daigaku-note/ops/dev1/'];
  assert.ok(tag0);
  assert.match(ops.text, /<d:href>\/dav\/daigaku-note\/ops\/dev1\/<\/d:href><d:propstat><d:prop><d:resourcetype><d:collection\/><\/d:resourcetype>/);

  // 変更のファイルを置く → フォルダの ETag が変わる
  const name = 'daigaku-note/ops/dev1/000000001-000000003.json';
  const body = JSON.stringify({ format: 'daigaku-note-ops', version: 1, device: 'dev1', ops: [{ id: 'dev1:1', t: '日本語' }] });
  const put = await req('PUT', name, { body, headers: { 'content-type': 'application/json' } });
  assert.equal(put.status, 201);
  assert.ok(put.headers.get('etag'));
  ops = await propfind(token, '/dav/daigaku-note/ops/');
  const tag1 = ops.items['/dav/daigaku-note/ops/dev1/'];
  assert.notEqual(tag1, tag0);
  const dir = await propfind(token, '/dav/daigaku-note/ops/dev1/');
  assert.equal(dir.status, 207);
  assert.equal(dir.items['/dav/daigaku-note/ops/dev1/'], tag1); // 自分自身も入る(アプリは読み飛ばす)
  assert.ok(dir.items['/dav/daigaku-note/ops/dev1/000000001-000000003.json']);
  assert.match(dir.text, /<d:getcontentlength>\d+<\/d:getcontentlength>/);

  // 中身は R2、D1 には目録(大きさ・ETag)だけ
  const uid = env.DB.q("SELECT id FROM users WHERE email = 'dav@example.com'")[0].id;
  const obj = env.FILES.objects.get(`u/${uid}/ops/dev1/000000001-000000003.json`);
  assert.equal(Buffer.from(obj.bytes).toString(), body);
  assert.deepEqual(env.DB.q('SELECT bytes FROM op_files WHERE user_id = ?', uid), [{ bytes: Buffer.byteLength(body) }]);
  assert.equal(dir.items['/dav/daigaku-note/ops/dev1/000000001-000000003.json'], put.headers.get('etag'));
  const get = await req('GET', name);
  assert.equal(get.status, 200);
  assert.equal(await get.text(), body);
  assert.equal(get.headers.get('etag'), put.headers.get('etag'));
  assert.equal((await req('HEAD', name)).status, 200);
  assert.equal((await req('GET', 'daigaku-note/ops/dev1/000000004-000000004.json')).status, 404);
  assert.equal((await req('GET', 'daigaku-note/ops/nodev/000000001-000000001.json')).status, 404);

  // 同じ名前に置き直す: 204、ETag も変わる、使っている量は差だけ増える
  const before = env.DB.q("SELECT bytes_used FROM users WHERE email = 'dav@example.com'")[0].bytes_used;
  const again = await req('PUT', name, { body: body + ' ' });
  assert.equal(again.status, 204);
  assert.notEqual(again.headers.get('etag'), put.headers.get('etag'));
  assert.equal(env.DB.q("SELECT bytes_used FROM users WHERE email = 'dav@example.com'")[0].bytes_used, before + 1);
  assert.notEqual((await propfind(token, '/dav/daigaku-note/ops/')).items['/dav/daigaku-note/ops/dev1/'], tag1);

  // MKCOL をせずに置いても、端末のフォルダができる
  assert.equal((await req('PUT', 'daigaku-note/ops/dev2/000000001-000000001.json', { body: '{}' })).status, 201);
  assert.ok((await propfind(token, '/dav/daigaku-note/ops/')).items['/dav/daigaku-note/ops/dev2/']);

  // PDF・画像は R2 へ
  const hash = 'b'.repeat(64);
  const pdf = new Uint8Array(3000).map((_, i) => i % 256);
  assert.equal((await req('HEAD', `daigaku-note/files/${hash}.pdf`)).status, 404);
  const fput = await req('PUT', `daigaku-note/files/${hash}.pdf`, { body: pdf, headers: { 'content-type': 'application/pdf' } });
  assert.equal(fput.status, 201);
  const user = env.DB.q("SELECT id FROM users WHERE email = 'dav@example.com'")[0];
  assert.ok(env.FILES.objects.has(`u/${user.id}/files/${hash}.pdf`));
  const head = await req('HEAD', `daigaku-note/files/${hash}.pdf`);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '3000');
  const fget = await req('GET', `daigaku-note/files/${hash}.pdf`);
  assert.equal(fget.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(new Uint8Array(await fget.arrayBuffer()), pdf);
  const files = await propfind(token, '/dav/daigaku-note/files/');
  assert.ok(files.items[`/dav/daigaku-note/files/${hash}.pdf`]);

  // Depth は 0 と 1 だけ
  assert.equal((await propfind(token, '/dav/daigaku-note/ops/', '0')).text.match(/<d:response>/g).length, 1);
  assert.equal((await propfind(token, '/dav/daigaku-note/ops/', 'infinity')).status, 403);
  // 受けない操作
  assert.equal((await req('DELETE', name)).status, 405);
  assert.equal((await req('MOVE', name)).status, 405);
  // 置けない形の住所を読む: 404
  assert.equal((await req('GET', 'daigaku-note/secret.txt')).status, 404);
  assert.equal((await propfind(token, '/dav/other/')).status, 404);
});

test('WebDAV: ほかの利用者の置き場は見えない。.. や %2e%2e でも出られない', async () => {
  const a = await login('alice@example.com');
  const b = await login('bob@example.com');
  const auth = (t) => ({ authorization: basic(t) });
  await call('/dav/daigaku-note/ops/alice1/000000001-000000001.json', { method: 'PUT', body: '{"secret":1}', headers: auth(a.token) });
  await call(`/dav/daigaku-note/files/${'c'.repeat(64)}.png`, { method: 'PUT', body: 'png', headers: auth(a.token) });
  assert.equal((await call('/dav/daigaku-note/ops/alice1/000000001-000000001.json', { headers: auth(b.token) })).status, 404);
  assert.equal((await call(`/dav/daigaku-note/files/${'c'.repeat(64)}.png`, { method: 'HEAD', headers: auth(b.token) })).status, 404);
  const bops = await propfind(b.token, '/dav/daigaku-note/ops/');
  assert.deepEqual(Object.keys(bops.items), ['/dav/daigaku-note/ops/']);

  // fetch は .. を手前で畳むので、生の HTTP で送る
  const raw = (path, method = 'GET') => new Promise((resolve, reject) => {
    const u = new URL(srv.url);
    const r = http.request({ host: u.hostname, port: u.port, path, method, headers: auth(b.token) }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', reject);
    r.end();
  });
  assert.equal(await raw('/dav/daigaku-note/files/../../../u/x'), 404);
  assert.equal(await raw('/dav/daigaku-note/ops/%2e%2e/%2e%2e/files/x.pdf'), 404);
  assert.equal(await raw('/dav/daigaku-note/ops/..%2f..%2falice1/000000001-000000001.json'), 404);
  assert.equal(await raw('/dav/daigaku-note/files/..%2F..%2Fx.pdf', 'PUT'), 403);
});

test('WebDAV: 大きさの上限(413)と容量の上限(507)', async () => {
  const qEnv = fakeEnv({ QUOTA_BYTES: '10000', MAX_FILE_BYTES: '6000', MAX_OP_BYTES: '7000' });
  const s2 = await startWorker(worker, qEnv);
  const c = captureMail();
  try {
    const p = (path, opts) => fetch(s2.url + path, opts);
    await p('/otp/send', { method: 'POST', body: JSON.stringify({ email: 'q@example.com' }) });
    const v = await (await p('/otp/verify', { method: 'POST', body: JSON.stringify({ email: 'q@example.com', code: c.lastCode() }) })).json();
    const auth = { authorization: basic(v.token), origin: ORIGIN };
    const put = (path, body) => p('/dav/daigaku-note/' + path, { method: 'PUT', body, headers: auth });
    // 変更のファイルは MAX_OP_BYTES まで(本番は 20MB)
    const big = await put('ops/d/000000001-000000001.json', 'x'.repeat(7001));
    assert.equal(big.status, 413);
    assert.equal(big.headers.get('access-control-allow-origin'), ORIGIN); // ブラウザでも 413 が見える
    // ファイルは MAX_FILE_BYTES まで(アプリは 413 なら変更だけ送る)
    assert.equal((await put(`files/${'d'.repeat(64)}.pdf`, new Uint8Array(6001))).status, 413);
    // 容量: 4000 + 5000 は入る、さらに 2000 は入らない
    assert.equal((await put(`files/${'e'.repeat(64)}.pdf`, new Uint8Array(4000))).status, 201);
    assert.equal((await put('ops/d/000000001-000000001.json', 'y'.repeat(5000))).status, 201);
    const full = await put(`files/${'f'.repeat(64)}.jpg`, new Uint8Array(2000));
    assert.equal(full.status, 507);
    assert.equal(full.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal((await put('ops/d/000000002-000000002.json', 'z'.repeat(2000))).status, 507);
    // 断った分は何も残らない(フォルダの ETag も変わらない)
    assert.equal(qEnv.DB.q('SELECT COUNT(*) AS n FROM op_files')[0].n, 1);
    assert.equal(qEnv.DB.q('SELECT COUNT(*) AS n FROM blobs')[0].n, 1);
    assert.equal(qEnv.DB.q('SELECT ver FROM op_logs')[0].ver, 1);
    // 同じ名前に小さく置き直すのは入る(差で数える)
    assert.equal((await put('ops/d/000000001-000000001.json', 'y'.repeat(3000))).status, 204);
    assert.equal((await put(`files/${'f'.repeat(64)}.jpg`, new Uint8Array(2000))).status, 201);
    const me = await (await p('/me', { headers: auth })).json();
    assert.deepEqual(me.usage, { bytes: 9000, quota: 10000 });
    // R2 に置けなかったら、確保した分を戻す
    // (変更のファイルも同じ。目録の行もできず、フォルダの ETag も変わらない)
    const verBefore = qEnv.DB.q('SELECT ver FROM op_logs')[0].ver;
    qEnv.FILES.failPut = true;
    assert.equal((await put(`files/${'a'.repeat(64)}.png`, new Uint8Array(500))).status, 500);
    assert.equal((await put('ops/d/000000002-000000002.json', 'w'.repeat(500))).status, 500);
    assert.equal((await put('ops/d/000000001-000000001.json', 'w'.repeat(500))).status, 500);
    qEnv.FILES.failPut = false;
    assert.equal(qEnv.DB.q("SELECT bytes_used FROM users WHERE email = 'q@example.com'")[0].bytes_used, 9000);
    assert.equal(qEnv.DB.q('SELECT COUNT(*) AS n FROM blobs')[0].n, 2);
    assert.deepEqual(qEnv.DB.q('SELECT from_n, bytes FROM op_files'), [{ from_n: 1, bytes: 3000 }]);
    assert.equal(qEnv.DB.q('SELECT ver FROM op_logs')[0].ver, verBefore);
    // 長さの分からない本文(chunked)は 411(R2 に流し込めないため)
    const chunked = (path) => new Promise((resolve, reject) => {
      const u = new URL(s2.url);
      const r = http.request({ host: u.hostname, port: u.port, path, method: 'PUT', headers: { authorization: auth.authorization, 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode); });
      r.on('error', reject);
      r.write('abc');
      r.end();
    });
    assert.equal(await chunked(`/dav/daigaku-note/files/${'9'.repeat(64)}.png`), 411);
    assert.equal(await chunked('/dav/daigaku-note/ops/d/000000005-000000005.json'), 411);
  } finally {
    c.restore();
    await s2.close();
  }
});

test('退会: D1 の行と R2 のファイルを全部消す(ほかの利用者のものは残す)', async () => {
  const a = await login('leave@example.com');
  const b = await login('stay@example.com');
  for (const t of [a.token, b.token]) {
    const h = { authorization: basic(t) };
    await call('/dav/daigaku-note/ops/x/000000001-000000001.json', { method: 'PUT', body: '{}', headers: h });
    await call(`/dav/daigaku-note/files/${'1'.repeat(64)}.pdf`, { method: 'PUT', body: 'pdf', headers: h });
  }
  const uid = a.userId;
  assert.ok([...env.FILES.objects.keys()].some((k) => k.startsWith(`u/${uid}/`)));
  const r = await api('/account', { method: 'DELETE', token: a.token });
  assert.equal(r.status, 200);
  for (const t of ['op_files', 'op_logs', 'blobs', 'devices']) assert.equal(env.DB.q(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, uid)[0].n, 0, t);
  assert.equal(env.DB.q('SELECT COUNT(*) AS n FROM users WHERE id = ?', uid)[0].n, 0);
  assert.equal(env.DB.q('SELECT COUNT(*) AS n FROM otp_requests WHERE email = ?', 'leave@example.com')[0].n, 0);
  assert.ok(![...env.FILES.objects.keys()].some((k) => k.startsWith(`u/${uid}/`)));
  assert.ok([...env.FILES.objects.keys()].some((k) => k.startsWith(`u/${b.userId}/`)));
  assert.equal((await api('/me', { token: a.token })).status, 401);
  assert.equal((await api('/me', { token: b.token })).status, 200);
  // 同じアドレスでまた始めると、別の利用者(前の ETag と重ならない)
  const again = await login('leave@example.com');
  assert.notEqual(again.userId, uid);
});

test('定期実行: 期限切れの行を消し、使っている量を数え直す', async () => {
  const { userId } = await login('cron@example.com');
  env.DB.x("INSERT INTO rate_limits (bucket, count, reset_at) VALUES ('old', 1, '2000-01-01T00:00:00.000Z')");
  env.DB.x("INSERT INTO otp_requests (id, email, code_hash, expires_at, created_at) VALUES ('o1', 'x@example.com', 'h', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')");
  env.DB.x('UPDATE users SET bytes_used = 12345 WHERE id = ?', userId);
  await cleanup(env);
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM rate_limits WHERE bucket = 'old'")[0].n, 0);
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM otp_requests WHERE id = 'o1'")[0].n, 0);
  assert.equal(env.DB.q('SELECT bytes_used FROM users WHERE id = ?', userId)[0].bytes_used, 0);
});

// ---- クーポンコード -------------------------------------------------------


// scripts/coupon.mjs と同じ形で D1 に入れる(サーバーには発行の受け口がない)
async function issueCoupon({ perk = 'adfree', days = null, expiresAt = null } = {}) {
  const code = newCouponCode();
  env.DB.x('INSERT INTO coupons (code_hash, perk, days, expires_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    await couponHash(normalizeCoupon(code)), perk, days, expiresAt, 'test', new Date().toISOString());
  return code;
}

test('クーポン: コードの形とそろえ方', () => {
  const c = newCouponCode();
  assert.match(c, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  assert.equal(normalizeCoupon(c.toLowerCase().replace(/-/g, ' ')), c.replace(/-/g, ''));
  // 全角・長音記号のハイフンも受ける
  const wide = c.replace(/[A-Z0-9]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).replace(/-/g, 'ー');
  assert.equal(normalizeCoupon(wide), c.replace(/-/g, ''));
  assert.equal(normalizeCoupon('ABCD-EFGH-IJKL'), null); // I は使わない文字
  assert.equal(normalizeCoupon('ABCD-EFGH-JKL'), null); // 短い
  assert.equal(normalizeCoupon(''), null);
});

test('クーポン: 1回だけ使える。特典が /me に載る。ほかの人は使えない', async () => {
  const a = await login('coupon-a@example.com');
  const b = await login('coupon-b@example.com');
  assert.deepEqual((await api('/me', { token: a.token })).data.perks, []);
  const code = await issueCoupon();

  const r = await api('/coupon', { method: 'POST', token: a.token, body: { code: code.toLowerCase() } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.perk, 'adfree');
  assert.equal(r.data.expiresAt, null);
  assert.deepEqual((await api('/me', { token: a.token })).data.perks, [{ perk: 'adfree', name: '広告なし', expiresAt: null }]);

  const again = await api('/coupon', { method: 'POST', token: a.token, body: { code } });
  assert.equal(again.status, 409);
  const other = await api('/coupon', { method: 'POST', token: b.token, body: { code } });
  assert.equal(other.status, 400);
  assert.deepEqual((await api('/me', { token: b.token })).data.perks, []);
  const row = env.DB.q('SELECT redeemed_by FROM coupons WHERE code_hash = ?', await couponHash(normalizeCoupon(code)))[0];
  assert.equal(row.redeemed_by, a.userId);

  // 鍵がなければ使えない
  assert.equal((await api('/coupon', { method: 'POST', body: { code } })).status, 401);
});

test('クーポン: 同時に2人が送っても、使えるのは1人だけ', async () => {
  const users = await Promise.all([1, 2, 3, 4].map((i) => login(`race${i}@example.com`)));
  const code = await issueCoupon();
  const rs = await Promise.all(users.map((u) => api('/coupon', { method: 'POST', token: u.token, body: { code } })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM perks WHERE perk = 'adfree' AND user_id IN (?, ?, ?, ?)", ...users.map((u) => u.userId))[0].n, 1);
});

test('クーポン: 期限切れ・存在しない・形が違う・止めたコード。ずっと持っている特典では使い切らない', async () => {
  const u = await login('coupon-c@example.com');
  const expired = await issueCoupon({ expiresAt: '2000-01-01T00:00:00.000Z' });
  assert.equal((await api('/coupon', { method: 'POST', token: u.token, body: { code: expired } })).status, 400);
  assert.equal((await api('/coupon', { method: 'POST', token: u.token, body: { code: newCouponCode() } })).status, 400);
  assert.equal((await api('/coupon', { method: 'POST', token: u.token, body: { code: 'hello' } })).status, 400);
  assert.equal((await api('/coupon', { method: 'POST', token: u.token, body: { code: '' } })).status, 400);

  const first = await issueCoupon();
  assert.equal((await api('/coupon', { method: 'POST', token: u.token, body: { code: first } })).status, 200);
  const second = await issueCoupon();
  const dup = await api('/coupon', { method: 'POST', token: u.token, body: { code: second } });
  assert.equal(dup.status, 409);
  assert.equal(env.DB.q('SELECT redeemed_by FROM coupons WHERE code_hash = ?', await couponHash(normalizeCoupon(second)))[0].redeemed_by, null);
});

test('クーポン: 日数つきの特典。期限つきどうしは遅いほう、切れたら /me から消える', async () => {
  const u = await login('coupon-d@example.com');
  const c30 = await issueCoupon({ perk: 'adfree', days: 30 });
  const r = await api('/coupon', { method: 'POST', token: u.token, body: { code: c30 } });
  assert.equal(r.status, 200);
  const exp = Date.parse(r.data.expiresAt);
  assert.ok(Math.abs(exp - (Date.now() + 30 * 86_400_000)) < 60_000, r.data.expiresAt);
  const c10 = await issueCoupon({ perk: 'adfree', days: 10 });
  const r2 = await api('/coupon', { method: 'POST', token: u.token, body: { code: c10 } });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.expiresAt, r.data.expiresAt); // 短いほうでは縮まない
  env.DB.x("UPDATE perks SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?", u.userId);
  assert.deepEqual((await api('/me', { token: u.token })).data.perks, []);
  // 切れたあとに使えば、そこから数え直す
  const c5 = await issueCoupon({ perk: 'adfree', days: 5 });
  const r3 = await api('/coupon', { method: 'POST', token: u.token, body: { code: c5 } });
  assert.ok(Math.abs(Date.parse(r3.data.expiresAt) - (Date.now() + 5 * 86_400_000)) < 60_000);
});

test('クーポン: 試す回数は1時間に10回まで', async () => {
  const u = await login('coupon-e@example.com');
  for (let i = 0; i < 10; i++) assert.equal((await api('/coupon', { method: 'POST', token: u.token, body: { code: newCouponCode() } })).status, 400);
  const good = await issueCoupon();
  assert.equal((await api('/coupon', { method: 'POST', token: u.token, body: { code: good } })).status, 429);
});

test('クーポン: 退会すると特典は消え、使ったコードは使用済みのまま残る', async () => {
  const u = await login('coupon-f@example.com');
  const code = await issueCoupon();
  assert.equal((await api('/coupon', { method: 'POST', token: u.token, body: { code } })).status, 200);
  assert.equal((await api('/account', { method: 'DELETE', token: u.token })).status, 200);
  assert.equal(env.DB.q('SELECT COUNT(*) AS n FROM perks WHERE user_id = ?', u.userId)[0].n, 0);
  assert.equal(env.DB.q('SELECT redeemed_by FROM coupons WHERE code_hash = ?', await couponHash(normalizeCoupon(code)))[0].redeemed_by, 'deleted');
  const again = await login('coupon-f@example.com');
  assert.equal((await api('/coupon', { method: 'POST', token: again.token, body: { code } })).status, 400);
});
