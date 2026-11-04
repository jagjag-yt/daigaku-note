// アプリ版の通信(js/native.js の http)のテスト。
// 本物のアプリの代わりに、Capacitor のプラグインのふりをするものを置いて確かめる。
//   Android: DavHttp(OkHttp のふりは Node の fetch で、テスト用 WebDAV サーバーに本当に送る)
//   iOS:     CapacitorHttp(Content-Type が JSON の応答を読み解いて返すくせもまねる)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 8139;
const DAV = `http://localhost:${PORT}/dav/`;
const AUTH = { Authorization: 'Basic ' + Buffer.from('test:pass').toString('base64') };
let server;

before(async () => {
  server = spawn(process.execPath, [new URL('./davserver.mjs', import.meta.url).pathname, String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => server.stdout.once('data', resolve));
});
after(() => server.kill());

// globalThis.Capacitor を置いてから、別の版として読み込む(読み込んだときに一度だけ見るため)
let n = 0;
async function load(capacitor) {
  globalThis.Capacitor = capacitor;
  try {
    return await import(`../js/native.js?v=${++n}`);
  } finally {
    delete globalThis.Capacitor;
  }
}
const b64 = (buf) => Buffer.from(buf).toString('base64');

// Android のプラグインのふり。DavHttpPlugin.java と同じ約束で動く:
//   writeChunk で本文をファイル(ここではメモリ)に書き足し、request で送り、受け取った本文はファイルの場所で返す。
//   画面は convertFileSrc の URL を fetch して読む(ここでは data: の URL)。リダイレクトは追いかけない
function fakeAndroid(log = []) {
  const ctrls = new Map();
  const files = new Map(); // 場所 → Buffer
  const cap = {
    log, files,
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    convertFileSrc: (p) => `data:application/octet-stream;base64,${files.get(p).toString('base64')}`,
    Plugins: {
      DavHttp: {
        async writeChunk({ id, data, append }) {
          const up = `/cache/davhttp/${id}.up`;
          files.set(up, Buffer.concat([append ? files.get(up) : Buffer.alloc(0), Buffer.from(data, 'base64')]));
        },
        async request(o) {
          log.push(o);
          const upFile = files.get(`/cache/davhttp/${o.id}.up`);
          if (o.bodyFile && (!upFile || (o.bodySize >= 0 && upFile.length !== o.bodySize))) {
            throw Object.assign(new Error('送る本文を用意できませんでした'), { code: 'NETWORK' });
          }
          const ctl = new AbortController();
          ctrls.set(o.id, ctl);
          const up = `/cache/davhttp/${o.id}.up`;
          try {
            const body = o.method === 'GET' || o.method === 'HEAD' ? undefined : (o.bodyFile ? files.get(up) : Buffer.alloc(0));
            o.sent = body ?? null;
            const res = await fetch(o.url, { method: o.method, headers: o.headers, body, signal: ctl.signal, redirect: 'manual' });
            const headers = {};
            res.headers.forEach((v, k) => { headers[k] = v; });
            const buf = Buffer.from(await res.arrayBuffer());
            const down = `/cache/davhttp/${o.id}.down`;
            files.set(down, buf);
            return { status: res.status, headers, file: down, size: buf.length };
          } catch (e) {
            throw Object.assign(new Error(e.message), { code: ctl.signal.aborted ? 'CANCELED' : 'NETWORK' });
          } finally {
            ctrls.delete(o.id);
            files.delete(up);
          }
        },
        async remove({ id }) { files.delete(`/cache/davhttp/${id}.up`); files.delete(`/cache/davhttp/${id}.down`); },
        async cancel({ id }) { log.push({ cancel: id }); ctrls.get(id)?.abort(); },
      },
    },
  };
  return cap;
}

test('ブラウザ版はそのまま fetch を使う', async () => {
  const m = await load(undefined);
  assert.equal(m.isNative, false);
  assert.equal(m.platform, 'web');
  const res = await m.http(DAV, { method: 'PROPFIND', headers: { ...AUTH, Depth: '0' } });
  assert.equal(res.status, 207);
});

test('Android: PROPFIND・MKCOL・PUT・GET がテスト用サーバーに届き、バイナリが壊れない', async () => {
  const cap = fakeAndroid();
  const m = await load(cap);
  assert.equal(m.isNative, true);
  assert.equal(m.platform, 'android');

  let res = await m.http(DAV + 'a/', { method: 'MKCOL', headers: AUTH });
  assert.equal(res.status, 201);
  res = await m.http(DAV + 'a/', { method: 'MKCOL', headers: AUTH });
  assert.equal(res.status, 405); // すでにある: エラーにせず状態を返す(fetch と同じ)

  const bytes = new Uint8Array(256 * 4);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256; // 0〜255 の全部のバイト
  res = await m.http(DAV + 'a/x.pdf', { method: 'PUT', headers: AUTH, body: new Blob([bytes], { type: 'application/pdf' }) });
  assert.equal(res.status, 201);
  // 種類が書かれていない本文には application/octet-stream を付ける(iOS で本文が落ちないように)
  assert.equal(cap.log.at(-1).headers['Content-Type'], 'application/octet-stream');

  res = await m.http(DAV + 'a/x.pdf', { headers: AUTH });
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  assert.equal(cap.log.at(-1).sent, null); // GET は本文を送らない

  const xml = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>';
  res = await m.http(DAV + 'a/', { method: 'PROPFIND', headers: { ...AUTH, Depth: '1', 'Content-Type': 'application/xml' }, body: xml });
  assert.equal(res.status, 207);
  assert.equal(cap.log.at(-1).sent.toString(), xml); // 文字の本文も UTF-8 のまま
  const text = await res.text();
  assert.match(text, /x\.pdf/);
  assert.match(res.headers.get('content-type') || '', /xml/);

  res = await m.http(DAV + 'a/none.json', { headers: AUTH });
  assert.equal(res.status, 404);
  res = await m.http(DAV, { method: 'PROPFIND', headers: { Depth: '0' } });
  assert.equal(res.status, 401);
});

test('Android: 大きなファイルは少しずつ渡して送り、受け取りもファイルを通す。使ったファイルは残さない', async () => {
  const cap = fakeAndroid();
  const m = await load(cap);
  const big = new Uint8Array(2_500_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 8)) % 256;
  let res = await m.http(DAV + 'big.pdf', { method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/pdf' }, body: new Blob([big]) });
  assert.equal(res.status, 201);
  assert.equal(cap.log.at(-1).bodyFile, true);
  res = await m.http(DAV + 'big.pdf', { headers: AUTH });
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), big);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cap.files.size, 0);
});

test('Android: 送る本文のファイルが消えていたら送らない(空の PUT を成功にしない)。受け取ったファイルが読めなければ失敗', async () => {
  const cap = fakeAndroid();
  const m = await load(cap);
  const write = cap.Plugins.DavHttp.writeChunk;
  cap.Plugins.DavHttp.writeChunk = async (o) => { await write(o); cap.files.delete(`/cache/davhttp/${o.id}.up`); };
  await assert.rejects(m.http(DAV + 'lost.pdf', { method: 'PUT', headers: AUTH, body: new Uint8Array(10) }), TypeError);
  cap.Plugins.DavHttp.writeChunk = write;
  let res = await m.http(DAV + 'lost.pdf', { headers: AUTH });
  assert.equal(res.status, 404); // 送っていない
  // 受け取ったファイルが OS に消された(読むと 404)
  const conv = cap.convertFileSrc;
  cap.convertFileSrc = () => 'data:text/plain,';
  await assert.rejects(m.http(DAV, { method: 'PROPFIND', headers: { ...AUTH, Depth: '1' } }), TypeError);
  cap.convertFileSrc = conv;
});

test('Android: 本文の用意の途中で取り消すと、送らずに AbortError', async () => {
  const cap = fakeAndroid();
  const m = await load(cap);
  const ctl = new AbortController();
  const p = m.http(DAV + 'x', { method: 'PUT', headers: AUTH, body: new Uint8Array(3_000_000), signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(cap.log.filter((o) => o.url).length, 0); // 送っていない
});

test('Android: 日本語の本文も UTF-8 で送れる', async () => {
  const m = await load(fakeAndroid());
  const json = JSON.stringify({ title: '生理学のノート', s: '✏️' });
  let res = await m.http(DAV + 'j.json', { method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: json });
  assert.equal(res.status, 201);
  res = await m.http(DAV + 'j.json', { headers: AUTH });
  assert.deepEqual(JSON.parse(await res.text()), JSON.parse(json));
});

test('Android: つながらないときは TypeError、時間切れは AbortError(fetch と同じ形)', async () => {
  const m = await load(fakeAndroid());
  await assert.rejects(m.http('http://localhost:1/x', { headers: AUTH }), TypeError);
  const timeout = await load({
    isNativePlatform: () => true, getPlatform: () => 'android',
    Plugins: { DavHttp: { request: async () => { throw Object.assign(new Error('時間切れ'), { code: 'TIMEOUT' }); }, cancel: async () => {}, writeChunk: async () => {}, remove: async () => {} } },
  });
  await assert.rejects(timeout.http(DAV), (e) => e.name === 'AbortError');
});

test('Android: signal で取り消すと AbortError になり、送っている通信も取り消す', async () => {
  const log = [];
  let release;
  const m = await load({
    isNativePlatform: () => true, getPlatform: () => 'android',
    Plugins: {
      DavHttp: {
        request: (o) => { log.push(o); return new Promise((_, reject) => { release = () => reject(Object.assign(new Error('取り消し'), { code: 'CANCELED' })); }); },
        cancel: async ({ id }) => { log.push({ cancel: id }); release(); },
        writeChunk: async () => {},
        remove: async () => {},
      },
    },
  });
  const ctl = new AbortController();
  const p = m.http(DAV + 'slow', { headers: AUTH, signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 10));
  ctl.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.equal(log[1].cancel, log[0].id);
  // 先に取り消してあれば送らない
  await assert.rejects(m.http(DAV, { signal: AbortSignal.abort() }), (e) => e.name === 'AbortError');
  assert.equal(log.filter((o) => o.url).length, 1);
});

test('Android: 204 は本文なし、使えない見出しは捨てる', async () => {
  const m = await load({
    isNativePlatform: () => true, getPlatform: () => 'android',
    Plugins: { DavHttp: { request: async () => ({ status: 204, headers: { ':status': '204', ETag: '"x"' }, file: '/x', size: 0 }), cancel: async () => {}, writeChunk: async () => {}, remove: async () => {} } },
  });
  const res = await m.http(DAV, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('etag'), '"x"');
  assert.equal(await res.text(), '');
});

test('iOS: CapacitorHttp に base64 の本文で頼み、JSON に読み解かれた応答も文字に戻す', async () => {
  const log = [];
  const m = await load({
    isNativePlatform: () => true, getPlatform: () => 'ios',
    Plugins: {
      CapacitorHttp: {
        async request(o) {
          log.push(o);
          if (o.method === 'GET') return { status: 200, headers: { 'content-type': 'application/json' }, data: { ops: [1, 2], t: 'あ' } };
          return { status: 201, headers: {}, data: '' };
        },
      },
    },
  });
  let res = await m.http(DAV + 'x', { method: 'PUT', body: new Uint8Array([0, 255, 1]) });
  assert.equal(res.status, 201);
  assert.equal(log[0].dataType, 'file');
  assert.equal(log[0].data, b64([0, 255, 1]));
  assert.equal(log[0].responseType, 'arraybuffer');
  assert.equal(log[0].headers['Content-Type'], 'application/octet-stream');
  res = await m.http(DAV + 'x');
  assert.deepEqual(JSON.parse(await res.text()), { ops: [1, 2], t: 'あ' });
  assert.equal(log[1].data, undefined);
});

test('iOS: JSON を読み解けなかった応答・本文のない応答・日本語の時間切れ', async () => {
  let reply;
  const m = await load({
    isNativePlatform: () => true, getPlatform: () => 'ios',
    Plugins: { CapacitorHttp: { request: async () => { if (reply instanceof Error) throw reply; return reply; } } },
  });
  // Content-Type が JSON なのに読み解けない: CapacitorHttp はエラーの文言を data に入れてくる。status は生かす
  reply = { status: 401, headers: { 'content-type': 'application/json' }, data: 'The data couldn’t be read because it isn’t in the correct format.' };
  let res = await m.http(DAV);
  assert.equal(res.status, 401);
  // 文字列だけの JSON は文字のまま(base64 として読まない)
  reply = { status: 200, headers: { 'Content-Type': 'application/json' }, data: 'abcd' };
  assert.equal(await (await m.http(DAV)).text(), 'abcd');
  reply = { status: 204, headers: { 'content-type': 'application/json' }, data: 'xx' };
  res = await m.http(DAV, { method: 'DELETE' });
  assert.equal(res.status, 204);
  reply = Object.assign(new Error('要求がタイムアウトになりました。'), { code: 'NSURLErrorDomain' });
  await assert.rejects(m.http(DAV), (e) => e.name === 'AbortError');
  reply = Object.assign(new Error('インターネット接続がオフラインのようです。'), { code: 'NSURLErrorDomain' });
  await assert.rejects(m.http(DAV), TypeError);
});

test('base64 の行き来で大きなバイナリも壊れない', async () => {
  const m = await load(undefined);
  const big = new Uint8Array(300_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7919) % 256;
  assert.deepEqual(m.fromBase64(await m.toBase64(big)), big);
  assert.deepEqual(m.fromBase64(await m.toBase64(new Blob([big]))), big);
  assert.equal(await m.toBase64(new Uint8Array(0)), '');
  assert.deepEqual(m.fromBase64('AAEC\n/w=='), new Uint8Array([0, 1, 2, 255])); // 改行入りの base64 も読む
});
