// メールの送り先(Amazon SES)と、Apple・Google でのログイン(server/src/mail.js・server/src/oauth.js)のテスト。
// Apple・Google・SES には実際には送らず、fetch を差し替えて、届いた中身を確かめる。
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/src/index.js';
import { encodeFrom, mailLimitDefaults, mailProvider, signAws } from '../server/src/mail.js';
import { allowedReturn, APP_RETURN, appleClientSecret, challengeOf, decodeJwt } from '../server/src/oauth.js';
import { fakeEnv, startWorker, captureMail } from './cf-fakes.mjs';

const WEB = 'https://jagjag-yt.github.io/daigaku-note/';
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const jwt = (claims) => `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(claims))}.sig`;

// Apple の鍵(テスト用に作る)。.p8 と同じ PKCS#8 の PEM にする
const appleKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', appleKeys.privateKey)).toString('base64');
const APPLE_PEM = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;

let env, srv, mail;
// Apple・Google の受け口の代わり。次に返す ID トークンの中身を idp.claims に入れる
const idp = { claims: null, requests: [], status: 200, revoked: [], refresh: null };

const logs = [];
const consoleLog = console.log;
before(async () => {
  console.log = (...a) => logs.push(a.map(String).join(' '));
  env = fakeEnv({
    OTP_BURST_SECONDS: '0',
    DEV_OAUTH_RETURNS: '1',
    AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'secret',
    GOOGLE_CLIENT_ID: 'g-client', GOOGLE_CLIENT_SECRET: 'g-secret',
    APPLE_CLIENT_ID: 'io.github.jagjagyt.daigakunote.web', APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567', APPLE_PRIVATE_KEY: APPLE_PEM,
  });
  srv = await startWorker(worker, env);
  mail = captureMail();
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/revoke') {
      idp.revoked.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      return new Response('', { status: 200 });
    }
    if (url === 'https://oauth2.googleapis.com/token' || url === 'https://appleid.apple.com/auth/token') {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      idp.requests.push({ url, form });
      if (idp.status !== 200) return new Response('{"error":"invalid_grant"}', { status: idp.status });
      return Response.json({ access_token: 'x', id_token: jwt(idp.claims), ...(idp.refresh ? { refresh_token: idp.refresh } : {}) });
    }
    return inner(input, init);
  };
});
after(async () => {
  console.log = consoleLog;
  mail.restore();
  await srv.close();
});
beforeEach(() => { idp.claims = null; idp.requests.length = 0; idp.status = 200; idp.revoked.length = 0; idp.refresh = null; });

const get = (path, opts = {}) => fetch(srv.url + path, { redirect: 'manual', ...opts });
const api = async (path, body) => {
  const res = await fetch(srv.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

/** ログインを始め、Apple・Google から戻るところまで。戻り先の # の中身(ticket など)と合言葉を返す */
async function flow(provider, claims, { returnTo = WEB, verifier = b64url(crypto.getRandomValues(new Uint8Array(32))), tamper } = {}) {
  const challenge = await challengeOf(verifier);
  const start = await get(`/oauth/${provider}/start?${new URLSearchParams({ return: returnTo, challenge })}`);
  assert.equal(start.status, 302);
  const auth = new URL(start.headers.get('location'));
  const state = auth.searchParams.get('state');
  const nonce = auth.searchParams.get('nonce');
  idp.claims = typeof claims === 'function' ? claims(nonce) : { nonce, ...claims };
  const params = { code: 'the-code', state: tamper?.state ?? state, ...(tamper?.error ? { error: tamper.error } : {}) };
  const cb = provider === 'google'
    ? await get(`/oauth/google/callback?${new URLSearchParams(params)}`)
    : await get('/oauth/apple/callback', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  // ブラウザ版へはリダイレクト、アプリへは meta refresh のページで戻す
  let loc = cb.headers.get('location');
  if (!loc && /text\/html/.test(cb.headers.get('content-type') ?? '')) {
    const html = await cb.clone().text();
    const m = /http-equiv="refresh" content="0;url=([^"]*)"/.exec(html);
    if (m) loc = m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  }
  const hash = loc ? new URLSearchParams(loc.split('#/oauth?')[1]) : null;
  return { auth, cb, loc, hash, verifier, state };
}

const redeem = (ticket, verifier, label) => api('/oauth/redeem', { ticket, verifier, label });

// ---- メール(SES) ----

test('SES: AWS の部品(botocore)と同じ署名になる', async () => {
  // 期待値は botocore 1.44 の SigV4Auth で同じ入力から作ったもの
  const body = `{"FromEmailAddress":"${encodeFrom('大学ノート <no-reply@quiz-make.com>')}","Destination":{"ToAddresses":["a@example.com"]}}`;
  const h = await signAws({
    method: 'POST', host: 'email.ap-northeast-1.amazonaws.com', path: '/v2/email/outbound-emails', region: 'ap-northeast-1', service: 'ses', body,
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', date: new Date('2026-11-18T16:00:00Z'),
  });
  assert.equal(h['x-amz-date'], '20261118T160000Z');
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261118/ap-northeast-1/ses/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=c5cc32865df9aa04b99affa9db7963100433b4d911694fca1267afd93817f663');
  assert.equal(h.host, undefined);
});

test('SES: 送り元の日本語の名前は RFC 2047 の形にする', () => {
  assert.equal(encodeFrom('大学ノート <no-reply@quiz-make.com>'), '=?UTF-8?B?5aSn5a2m44OO44O844OI?= <no-reply@quiz-make.com>');
  assert.equal(encodeFrom('Daigaku "Note" <a@b.c>'), '"Daigaku \\"Note\\"" <a@b.c>');
  assert.equal(encodeFrom('<a@b.c>'), 'a@b.c');
  // 長い名前は、75文字までの encoded-word に分ける(文字の途中では切らない)
  const long = encodeFrom(`${'あ'.repeat(40)} <a@b.c>`);
  const words = long.replace(' <a@b.c>', '').split(' ');
  assert.ok(words.length > 1);
  for (const w of words) assert.ok(w.length <= 75, w);
  const decoded = words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
  assert.equal(decoded, 'あ'.repeat(40));
  assert.equal(encodeFrom('a@b.c'), 'a@b.c');
});

test('SES: 送り先の選び方と、上限の既定値', () => {
  assert.equal(mailProvider({ AWS_ACCESS_KEY_ID: 'x' }), 'ses');
  assert.equal(mailProvider({ RESEND_API_KEY: 'x' }), 'resend');
  assert.equal(mailProvider({ AWS_ACCESS_KEY_ID: 'x', MAIL_PROVIDER: 'resend' }), 'resend');
  assert.deepEqual(mailLimitDefaults({ AWS_ACCESS_KEY_ID: 'x' }), { day: 2000, month: 30000 });
  assert.deepEqual(mailLimitDefaults({}), { day: 90, month: 2900 });
});

test('SES: ログインの番号は SES の東京から送られ、署名と本文が付いている', async () => {
  const s = await api('/otp/send', { email: 'ses@example.com', purpose: 'signup' });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const m = mail.mails.at(-1);
  assert.equal(m.via, 'ses');
  assert.equal(m.url, 'https://email.ap-northeast-1.amazonaws.com/v2/email/outbound-emails');
  assert.match(m.auth, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-northeast-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.deepEqual(m.to, ['ses@example.com']);
  assert.equal(m.from, '=?UTF-8?B?5aSn5a2m44OO44O844OI?= <no-reply@example.com>');
  assert.match(m.subject, /アカウント作成の確認番号: \d{6}/);
  assert.equal(m.raw.Content.Simple.Body.Text.Charset, 'UTF-8');
  const v = await api('/otp/verify', { email: 'ses@example.com', code: mail.lastCode('ses@example.com'), purpose: 'signup' });
  assert.equal(v.status, 200);
});

test('SES: 送れなかったら 502 を返す(黙って成功にしない)', async () => {
  mail.fail = true;
  try {
    const s = await api('/otp/send', { email: 'sesfail@example.com', purpose: 'login' });
    assert.equal(s.status, 502);
  } finally {
    mail.fail = false;
  }
});

// ---- Apple・Google ----

test('設定が済んでいる方法を返す', async () => {
  const r = await (await get('/oauth/providers')).json();
  assert.deepEqual(r.providers, { apple: true, google: true });
  // 設定がなければ false(ボタンを出さない)
  const bare = await startWorker(worker, fakeEnv());
  try {
    const r2 = await (await fetch(bare.url + '/oauth/providers')).json();
    assert.deepEqual(r2.providers, { apple: false, google: false });
    const st = await fetch(`${bare.url}/oauth/google/start?${new URLSearchParams({ return: WEB, challenge: 'a'.repeat(43) })}`, { redirect: 'manual' });
    assert.equal(st.status, 302);
    assert.match(st.headers.get('location'), /#\/oauth\?error=unavailable&provider=google$/);
  } finally {
    await bare.close();
  }
});

test('Google: 初めての人はアカウントができ、2回目は同じアカウントに入る', async () => {
  const f = await flow('google', { iss: 'https://accounts.google.com', aud: 'g-client', exp: Date.now() / 1000 + 600, sub: 'g-1', email: 'Taro@Gmail.com', email_verified: true });
  // Google のログインの画面へ送る中身
  assert.equal(f.auth.origin + f.auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(f.auth.searchParams.get('client_id'), 'g-client');
  assert.equal(f.auth.searchParams.get('redirect_uri'), `${srv.url}/oauth/google/callback`);
  assert.equal(f.auth.searchParams.get('scope'), 'openid email');
  // 引き換え: client_secret を付けて、こちらから聞いている
  assert.equal(idp.requests[0].form.client_secret, 'g-secret');
  assert.equal(idp.requests[0].form.code, 'the-code');
  // ブラウザ版の戻り先へ、# のあとに引換券を付けて戻す
  assert.ok(f.loc.startsWith(`${WEB}#/oauth?`), f.loc);
  assert.equal(f.hash.get('provider'), 'google');
  const r = await redeem(f.hash.get('ticket'), f.verifier, 'テスト端末');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.email, 'taro@gmail.com');
  assert.equal(r.data.existing, false);
  assert.equal(r.data.deviceLabel, 'テスト端末');
  assert.match(r.data.token, /^dn_[0-9a-f]{64}$/);
  // その鍵で同期の置き場などが使える
  const me = await (await fetch(srv.url + '/me', { headers: { authorization: `Bearer ${r.data.token}` } })).json();
  assert.equal(me.email, 'taro@gmail.com');

  // メールアドレスが変わっても、同じ Google のアカウントなら同じ利用者
  const f2 = await flow('google', { iss: 'accounts.google.com', aud: 'g-client', exp: Date.now() / 1000 + 600, sub: 'g-1', email: 'taro2@gmail.com', email_verified: true });
  const r2 = await redeem(f2.hash.get('ticket'), f2.verifier);
  assert.equal(r2.data.userId, r.data.userId);
  assert.equal(r2.data.existing, true);
});

test('Google: メールの番号で作ったアカウントにつながる(Gmail)', async () => {
  const s = await api('/otp/send', { email: 'hana@gmail.com', purpose: 'signup' });
  assert.equal(s.status, 200);
  const v = await api('/otp/verify', { email: 'hana@gmail.com', code: mail.lastCode('hana@gmail.com'), purpose: 'signup' });
  const f = await flow('google', { iss: 'https://accounts.google.com', aud: 'g-client', exp: Date.now() / 1000 + 600, sub: 'g-hana', email: 'hana@gmail.com', email_verified: true });
  const r = await redeem(f.hash.get('ticket'), f.verifier);
  assert.equal(r.data.userId, v.data.userId);
  assert.equal(r.data.existing, true);
});

test('Google: ほかの会社のアドレスで前からあるアカウントには、つながずにメールの番号を使ってもらう', async () => {
  await api('/otp/send', { email: 'old@univ.example.jp', purpose: 'signup' });
  await api('/otp/verify', { email: 'old@univ.example.jp', code: mail.lastCode('old@univ.example.jp'), purpose: 'signup' });
  const f = await flow('google', { iss: 'https://accounts.google.com', aud: 'g-client', exp: Date.now() / 1000 + 600, sub: 'g-old', email: 'old@univ.example.jp', email_verified: true });
  assert.equal(f.hash.get('error'), 'use_email');
  assert.equal(f.hash.get('ticket'), null);
  // Google Workspace(hd がある)なら、Google が持ち主を管理しているのでつなぐ
  const f2 = await flow('google', { iss: 'https://accounts.google.com', aud: 'g-client', exp: Date.now() / 1000 + 600, sub: 'g-old2', email: 'old@univ.example.jp', email_verified: true, hd: 'univ.example.jp' });
  const r = await redeem(f2.hash.get('ticket'), f2.verifier);
  assert.equal(r.status, 200);
  assert.equal(r.data.existing, true);
  // 前からのアカウントがなければ、ほかの会社のアドレスでも新しく作る(ただし「持ち主を確かめていない」印を付ける)
  const claims3 = { iss: 'https://accounts.google.com', aud: 'g-client', exp: Date.now() / 1000 + 600, sub: 'g-new', email: 'new@corp.example.com', email_verified: true };
  const f3 = await flow('google', claims3);
  const r3 = await redeem(f3.hash.get('ticket'), f3.verifier);
  assert.equal(r3.data.existing, false);
  assert.equal(r3.data.email, 'new@corp.example.com');
  // 本当の持ち主があとでメールの番号でログインすると、先に作られたアカウントには入らず、新しいアカウントになる(事前の乗っ取りを防ぐ)
  await api('/otp/send', { email: 'new@corp.example.com', purpose: 'login' });
  const v = await api('/otp/verify', { email: 'new@corp.example.com', code: mail.lastCode('new@corp.example.com'), purpose: 'login' });
  assert.equal(v.status, 404); // ログインのページでは「アカウントはありません」(番号はそのまま使える)
  const v2 = await api('/otp/verify', { email: 'new@corp.example.com', code: mail.lastCode('new@corp.example.com'), purpose: 'signup' });
  assert.equal(v2.status, 200);
  assert.equal(v2.data.existing, false);
  assert.notEqual(v2.data.userId, r3.data.userId);
  // 先に作られたアカウントは、Google でだけ入れる(アドレスは外れている)
  const f4 = await flow('google', claims3);
  const r4 = await redeem(f4.hash.get('ticket'), f4.verifier);
  assert.equal(r4.data.userId, r3.data.userId);
  assert.equal(r4.data.email, `${r3.data.userId}@unverified.invalid`);
  // Gmail の持ち主が Google でログインしたときも、先に(確かめずに)作られたアカウントからアドレスを外す
  const fa = await flow('apple', { iss: 'https://appleid.apple.com', aud: 'io.github.jagjagyt.daigakunote.web', exp: Date.now() / 1000 + 600, sub: 'a-squat', email: 'squat@gmail.com', email_verified: 'true' });
  const ra = await redeem(fa.hash.get('ticket'), fa.verifier);
  const fg = await flow('google', { iss: 'https://accounts.google.com', aud: 'g-client', exp: Date.now() / 1000 + 600, sub: 'g-squat', email: 'squat@gmail.com', email_verified: true });
  const rg = await redeem(fg.hash.get('ticket'), fg.verifier);
  assert.equal(rg.data.existing, false);
  assert.notEqual(rg.data.userId, ra.data.userId);
});

test('Apple: 持ち主と言い切れるのは「メールを非公開」と iCloud のアドレスだけ', async () => {
  await api('/otp/send', { email: 'mine@example.org', purpose: 'signup' });
  await api('/otp/verify', { email: 'mine@example.org', code: mail.lastCode('mine@example.org'), purpose: 'signup' });
  const base = { iss: 'https://appleid.apple.com', aud: 'io.github.jagjagyt.daigakunote.web', exp: Date.now() / 1000 + 600, email_verified: 'true' };
  const f = await flow('apple', { ...base, sub: 'a-mine', email: 'mine@example.org' });
  assert.equal(f.hash.get('error'), 'use_email');
  await api('/otp/send', { email: 'me@icloud.com', purpose: 'signup' });
  const v = await api('/otp/verify', { email: 'me@icloud.com', code: mail.lastCode('me@icloud.com'), purpose: 'signup' });
  const f2 = await flow('apple', { ...base, sub: 'a-icloud', email: 'me@icloud.com' });
  const r2 = await redeem(f2.hash.get('ticket'), f2.verifier);
  assert.equal(r2.data.userId, v.data.userId);
});

test('Apple: 退会すると、Apple に取り消しを頼む', async () => {
  idp.refresh = 'apple-refresh-1';
  const f = await flow('apple', { iss: 'https://appleid.apple.com', aud: 'io.github.jagjagyt.daigakunote.web', exp: Date.now() / 1000 + 600, sub: 'a-rev', email: 'rev@privaterelay.appleid.com', email_verified: true, is_private_email: true });
  const r = await redeem(f.hash.get('ticket'), f.verifier);
  const del = await fetch(srv.url + '/account', { method: 'DELETE', headers: { authorization: `Bearer ${r.data.token}` } });
  assert.equal(del.status, 200);
  assert.equal(idp.revoked.length, 1);
  assert.equal(idp.revoked[0].token, 'apple-refresh-1');
  assert.equal(idp.revoked[0].token_type_hint, 'refresh_token');
  assert.equal(idp.revoked[0].client_id, 'io.github.jagjagyt.daigakunote.web');
  assert.equal(idp.revoked[0].client_secret.split('.').length, 3);
});

test('Google: 確かめていないアドレスではアカウントを作らない', async () => {
  const f = await flow('google', { iss: 'https://accounts.google.com', aud: 'g-client', exp: Date.now() / 1000 + 600, sub: 'g-unv', email: 'unv@gmail.com', email_verified: false });
  assert.equal(f.hash.get('error'), 'no_email');
});

test('Google: 宛先・発行元・期限・nonce が違う ID トークンは断る', async () => {
  const base = { iss: 'https://accounts.google.com', aud: 'g-client', exp: Date.now() / 1000 + 600, sub: 'g-bad', email: 'bad@gmail.com', email_verified: true };
  for (const bad of [{ aud: 'other' }, { iss: 'https://evil.example' }, { exp: Date.now() / 1000 - 1 }, { sub: '' }]) {
    const f = await flow('google', { ...base, ...bad });
    assert.equal(f.hash.get('error'), 'failed', JSON.stringify(bad));
  }
  const f = await flow('google', () => ({ ...base, nonce: 'wrong' }));
  assert.equal(f.hash.get('error'), 'failed');
  // Google が引き換えを断った
  idp.status = 400;
  const f2 = await flow('google', base);
  assert.equal(f2.hash.get('error'), 'failed');
});

test('Google: 取り消したら cancelled で戻す', async () => {
  const f = await flow('google', {}, { tamper: { error: 'access_denied' } });
  assert.equal(f.hash.get('error'), 'cancelled');
  assert.equal(idp.requests.length, 0);
});

test('state は1回だけ。知らない state は戻り先に戻さず、ことばのページ', async () => {
  const f = await flow('google', { iss: 'https://accounts.google.com', aud: 'g-client', exp: Date.now() / 1000 + 600, sub: 'g-st', email: 'st@gmail.com', email_verified: true });
  assert.ok(f.hash.get('ticket'));
  const again = await get(`/oauth/google/callback?${new URLSearchParams({ code: 'x', state: f.state })}`);
  assert.equal(again.status, 400);
  assert.equal(again.headers.get('location'), null);
  assert.match(again.headers.get('content-type'), /text\/html/);
  assert.match(again.headers.get('content-security-policy'), /style-src 'unsafe-inline'/);
  assert.match(await again.text(), /見つかりません/);
  // Apple の state を Google の戻り口に使っても通らない
  const g = await flow('apple', {}, { tamper: { state: 'x'.repeat(43) } });
  assert.equal(g.cb.status, 400);
});

test('引換券は始めた端末の合言葉がないと使えず、1回だけ', async () => {
  const f = await flow('google', { iss: 'https://accounts.google.com', aud: 'g-client', exp: Date.now() / 1000 + 600, sub: 'g-pk', email: 'pk@gmail.com', email_verified: true });
  const ticket = f.hash.get('ticket');
  const wrong = await redeem(ticket, b64url(crypto.getRandomValues(new Uint8Array(32))));
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.message, /端末と違う/);
  // 合言葉を間違えたら、その引換券はもう使えない(何度も試せない)
  const right = await redeem(ticket, f.verifier);
  assert.equal(right.status, 400);
  // 新しく始めれば使える。使えるのは1回だけ
  const f2 = await flow('google', { iss: 'https://accounts.google.com', aud: 'g-client', exp: Date.now() / 1000 + 600, sub: 'g-pk', email: 'pk@gmail.com', email_verified: true });
  assert.equal((await redeem(f2.hash.get('ticket'), f2.verifier)).status, 200);
  assert.equal((await redeem(f2.hash.get('ticket'), f2.verifier)).status, 400);
  // 形が違うものは調べずに断る
  assert.equal((await redeem('short', f2.verifier)).status, 400);
});

test('戻り先は大学ノートの住所だけ', async () => {
  assert.equal(allowedReturn(WEB), WEB);
  assert.equal(allowedReturn(`${WEB}?x=1#/login`), WEB);
  assert.equal(allowedReturn(APP_RETURN), APP_RETURN);
  // 手元の住所は、試験の設定のときだけ
  assert.equal(allowedReturn('http://localhost:8123/'), null);
  assert.equal(allowedReturn('http://localhost:8123/', { DEV_OAUTH_RETURNS: '1' }), 'http://localhost:8123/');
  for (const bad of ['https://evil.example/', 'https://jagjag-yt.github.io/', 'https://jagjag-yt.github.io/other-repo/', 'https://jagjag-yt.github.io.evil.example/', 'https://user:pw@jagjag-yt.github.io/daigaku-note/', 'javascript:alert(1)', 'io.github.jagjagyt.daigakunote://evil', '']) {
    assert.equal(allowedReturn(bad), null, bad);
  }
  const st = await get(`/oauth/google/start?${new URLSearchParams({ return: 'https://evil.example/', challenge: 'a'.repeat(43) })}`);
  assert.equal(st.status, 400);
  assert.equal(st.headers.get('location'), null);
  const st2 = await get(`/oauth/google/start?${new URLSearchParams({ return: WEB, challenge: 'short' })}`);
  assert.equal(st2.status, 400);
});

test('Apple: 署名した client_secret で引き換え、アプリの住所へ戻す', async () => {
  const f = await flow('apple', { iss: 'https://appleid.apple.com', aud: 'io.github.jagjagyt.daigakunote.web', exp: Date.now() / 1000 + 600, sub: 'a-1', email: 'abc123@privaterelay.appleid.com', email_verified: 'true', is_private_email: 'true' }, { returnTo: APP_RETURN });
  assert.equal(f.auth.origin + f.auth.pathname, 'https://appleid.apple.com/auth/authorize');
  assert.equal(f.auth.searchParams.get('response_mode'), 'form_post');
  assert.equal(f.auth.searchParams.get('scope'), 'email');
  // client_secret は Apple の鍵で署名した ES256 の JWT
  const secret = idp.requests[0].form.client_secret;
  const [h, c, sig] = secret.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567' });
  const claims = decodeJwt(secret);
  assert.equal(claims.iss, 'TEAM123456');
  assert.equal(claims.sub, 'io.github.jagjagyt.daigakunote.web');
  assert.equal(claims.aud, 'https://appleid.apple.com');
  assert.ok(claims.exp - claims.iat <= 300);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, appleKeys.publicKey, Buffer.from(sig, 'base64url'), new TextEncoder().encode(`${h}.${c}`));
  assert.ok(ok, '署名が Apple の鍵の公開鍵で確かめられる');
  // アプリへ戻す: すぐに移るページ(meta refresh)と、押せるリンク
  assert.equal(f.cb.status, 200);
  assert.match(f.cb.headers.get('content-security-policy'), /default-src 'none'/);
  assert.ok(f.loc.startsWith(`${APP_RETURN}#/oauth?`), f.loc);
  const html = await f.cb.text();
  assert.match(html, /大学ノートに戻る/);
  assert.ok(html.includes(f.loc.replace(/&/g, '&amp;')));
  const r = await redeem(f.hash.get('ticket'), f.verifier, 'iPhone・iPad のアプリ');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.email, 'abc123@privaterelay.appleid.com');
});

test('Apple: 改行を \\n と書いた鍵でも読める(Cloudflare の画面に1行で貼ったとき)', async () => {
  const s = await appleClientSecret({ ...env, APPLE_PRIVATE_KEY: APPLE_PEM.replace(/\n/g, '\\n') });
  assert.equal(s.split('.').length, 3);
});

test('Apple: 取り消したら cancelled', async () => {
  const f = await flow('apple', {}, { tamper: { error: 'user_cancelled_authorize' } });
  assert.equal(f.hash.get('error'), 'cancelled');
});

test('退会すると、Apple・Google のつながりも消える(次は新しいアカウント)', async () => {
  const claims = { iss: 'https://accounts.google.com', aud: 'g-client', exp: Date.now() / 1000 + 600, sub: 'g-del', email: 'del@gmail.com', email_verified: true };
  const f = await flow('google', claims);
  const r = await redeem(f.hash.get('ticket'), f.verifier);
  const del = await fetch(srv.url + '/account', { method: 'DELETE', headers: { authorization: `Bearer ${r.data.token}` } });
  assert.equal(del.status, 200);
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM identities WHERE subject = ?').bind('g-del').first();
  assert.equal(left.n, 0);
  const f2 = await flow('google', claims);
  const r2 = await redeem(f2.hash.get('ticket'), f2.verifier);
  assert.equal(r2.data.existing, false);
  assert.notEqual(r2.data.userId, r.data.userId);
});

test('始めた回数は IP ごとに数える(本番の IP が付いたとき)', async () => {
  const many = [];
  for (let i = 0; i < 31; i++) {
    many.push(get(`/oauth/google/start?${new URLSearchParams({ return: WEB, challenge: 'b'.repeat(43) })}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } }));
  }
  const res = await Promise.all(many);
  const locs = res.map((r) => r.headers.get('location'));
  assert.equal(locs.filter((l) => l.startsWith('https://accounts.google.com/')).length, 30);
  assert.equal(locs.filter((l) => l.endsWith('error=rate&provider=google')).length, 1);
});
