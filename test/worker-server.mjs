// 同期サーバー(server/)を手元で動かす(テスト用。D1・R2 はメモリ上の代わりで、止めると消える)。
//   node test/worker-server.mjs 8131
// 画面のテスト(test/ui/account.spec.js)が使う。メールは送らず、番号を応答の devCode に入れる(DEV_ECHO_OTP)。
// クーポンコードは、本番では scripts/coupon.mjs が D1 に直接書く。ここでは試験用に POST /__test/coupon で作れるようにする
// (このファイルだけの受け口。本番の server/src/index.js にはない)。
import worker from '../server/src/index.js';
import { couponHash, newCouponCode, normalizeCoupon } from '../server/src/coupon.js';
import { fakeEnv, startWorker } from './cf-fakes.mjs';

const port = Number(process.argv[2]) || 8131;
const testWorker = {
  ...worker,
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/__test/coupon' || request.method !== 'POST') return worker.fetch(request, env);
    const { perk = 'adfree', days = null } = await request.json().catch(() => ({}));
    const code = newCouponCode();
    await env.DB.prepare('INSERT INTO coupons (code_hash, perk, days, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await couponHash(normalizeCoupon(code)), perk, days, 'test', new Date().toISOString()).run();
    return Response.json({ code });
  },
};
// Apple・Google でのログインの代わり(server/src/oauth.js)。画面のテストは Apple・Google のログインの画面を
// page.route で差し替え、code に { sub, email, nonce } を base64url の JSON で入れて戻す。引き換えはここで答える
const appleKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const applePem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', appleKey.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const iss = { 'https://oauth2.googleapis.com/token': 'https://accounts.google.com', 'https://appleid.apple.com/auth/token': 'https://appleid.apple.com' }[url];
  if (!iss) return realFetch(input, init);
  const form = new URLSearchParams(String(init.body));
  let claims;
  try { claims = JSON.parse(Buffer.from(form.get('code'), 'base64url').toString()); } catch { return Response.json({ error: 'invalid_grant' }, { status: 400 }); }
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const idToken = `${b64({ alg: 'none' })}.${b64({ iss, aud: form.get('client_id'), exp: Date.now() / 1000 + 600, email_verified: true, ...claims })}.x`;
  return Response.json({ id_token: idToken });
};
const srv = await startWorker(testWorker, fakeEnv({
  DEV_ECHO_OTP: '1', OTP_BURST_SECONDS: '0',
  GOOGLE_CLIENT_ID: 'test-google', GOOGLE_CLIENT_SECRET: 'test-secret',
  APPLE_CLIENT_ID: 'test.apple', APPLE_TEAM_ID: 'TEAM', APPLE_KEY_ID: 'KEY', APPLE_PRIVATE_KEY: applePem,
}), port);
console.log('同期サーバー(テスト用):', srv.url);
