// 同期サーバー(server/)を手元で動かす(テスト用。D1・R2 はメモリ上の代わりで、止めると消える)。
//   node test/worker-server.mjs 8131
// 画面のテスト(test/ui/account.spec.js)が使う。メールは送らず、番号を応答の devCode に入れる(DEV_ECHO_OTP)。
import worker from '../server/src/index.js';
import { fakeEnv, startWorker } from './cf-fakes.mjs';

const port = Number(process.argv[2]) || 8131;
const srv = await startWorker(worker, fakeEnv({ DEV_ECHO_OTP: '1', OTP_BURST_SECONDS: '0' }), port);
console.log('同期サーバー(テスト用):', srv.url);
