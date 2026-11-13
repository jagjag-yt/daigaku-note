// 同期サーバー(server/)のテスト: ログイン・端末・CORS・WebDAV のまね・容量。
// D1 は本物の SQLite(node:sqlite)、R2 はメモリ上の代わり(test/cf-fakes.mjs)。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import worker, { cleanup } from '../server/src/index.js';
import { parseDavPath } from '../server/src/dav.js';
import { fakeEnv, startWorker, captureMail } from './cf-fakes.mjs';

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

test('ログイン: 送信の回数の上限(続けての送信・IP ごと)', async () => {
  const burstEnv = fakeEnv(); // OTP_BURST_SECONDS なし = 60秒
  const s2 = await startWorker(worker, burstEnv);
  try {
    const send = (email, ip) => fetch(s2.url + '/otp/send', { method: 'POST', headers: { 'content-type': 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}) }, body: JSON.stringify({ email }) });
    assert.equal((await send('burst@example.com')).status, 200);
    const r = await send('burst@example.com');
    assert.equal(r.status, 429);
    assert.match((await r.json()).message, /続けて/);
    // IP ごと: 1時間に30回まで(アドレスを変えても)
    let last;
    for (let i = 0; i < 31; i++) last = await send(`ip${i}@example.com`, '203.0.113.9');
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
  const qEnv = fakeEnv({ QUOTA_BYTES: '10000', MAX_FILE_BYTES: '6000' });
  const s2 = await startWorker(worker, qEnv);
  const c = captureMail();
  try {
    const p = (path, opts) => fetch(s2.url + path, opts);
    await p('/otp/send', { method: 'POST', body: JSON.stringify({ email: 'q@example.com' }) });
    const v = await (await p('/otp/verify', { method: 'POST', body: JSON.stringify({ email: 'q@example.com', code: c.lastCode() }) })).json();
    const auth = { authorization: basic(v.token), origin: ORIGIN };
    const put = (path, body) => p('/dav/daigaku-note/' + path, { method: 'PUT', body, headers: auth });
    // 変更のファイルは 1.9MB まで
    const big = await put('ops/d/000000001-000000001.json', 'x'.repeat(1_900_001));
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
    qEnv.FILES.failPut = true;
    assert.equal((await put(`files/${'a'.repeat(64)}.png`, new Uint8Array(500))).status, 500);
    qEnv.FILES.failPut = false;
    assert.equal(qEnv.DB.q("SELECT bytes_used FROM users WHERE email = 'q@example.com'")[0].bytes_used, 9000);
    assert.equal(qEnv.DB.q('SELECT COUNT(*) AS n FROM blobs')[0].n, 2);
    // 長さの分からない本文(chunked)は 411
    const chunked = await new Promise((resolve, reject) => {
      const u = new URL(s2.url);
      const r = http.request({ host: u.hostname, port: u.port, path: `/dav/daigaku-note/files/${'9'.repeat(64)}.png`, method: 'PUT', headers: { authorization: auth.authorization, 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode); });
      r.on('error', reject);
      r.write('abc');
      r.end();
    });
    assert.equal(chunked, 411);
    // UTF-8 でない変更のファイルは断る
    assert.equal((await put('ops/d/000000003-000000003.json', new Uint8Array([0xff, 0xfe, 0x00]))).status, 400);
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
