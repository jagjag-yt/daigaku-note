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
const srv = await startWorker(testWorker, fakeEnv({ DEV_ECHO_OTP: '1', OTP_BURST_SECONDS: '0' }), port);
console.log('同期サーバー(テスト用):', srv.url);
