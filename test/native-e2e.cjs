// アプリ版(Android)の動きを、ブラウザの中で再現して確かめる(Playwright)。
// 本物のアプリの代わりに window.Capacitor とプラグイン(DavHttp・App・Filesystem・Share)のふりを入れる。
//   DavHttp は Node 側で本当に WebDAV サーバーへ送る(ブラウザからは送らない = CORS を通らない)。
//
//   node serve.mjs 8124 &  /  node test/davserver.mjs 8125 &
//   URL=http://localhost:8124/ DAV=http://localhost:8125/dav/ node test/native-e2e.cjs
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://localhost:8124/';
const DAV = process.env.DAV || 'http://localhost:8125/dav/';
const log = (...a) => console.log('✓', ...a);
const fail = (m) => { throw new Error(m); };

const fakeCapacitor = () => {
  window.__native = { back: null, minimized: 0, written: [], shared: [], shareCancel: false };
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: {
      DavHttp: { request: (o) => window.__nativeRequest(o), cancel: async () => {} },
      App: {
        addListener: async (ev, cb) => { if (ev === 'backButton') window.__native.back = cb; return { remove() {} }; },
        minimizeApp: async () => { window.__native.minimized++; },
      },
      Filesystem: { writeFile: async (o) => { window.__native.written.push(o); return { uri: 'file:///cache/' + o.path }; } },
      Share: {
        share: async (o) => {
          if (window.__native.shareCancel) throw new Error('Share canceled');
          window.__native.shared.push(o);
          return {};
        },
      },
    },
  };
};

async function draw(page, pts) {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
}

async function device(browser, viewport, errors, name) {
  const ctx = await browser.newContext({ viewport, hasTouch: false });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  // ブラウザから WebDAV サーバーへ直接送ったら失敗(アプリ版では OS の通信だけを使うはず)
  page.on('request', (r) => { if (r.url().startsWith(DAV)) errors.push(`${name}: ブラウザから直接送った ${r.method()} ${r.url()}`); });
  const sent = [];
  await page.exposeFunction('__nativeRequest', async (o) => {
    sent.push(o.method);
    const res = await fetch(o.url, { method: o.method, headers: o.headers, body: o.body == null ? undefined : Buffer.from(o.body, 'base64') });
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()).toString('base64') };
  });
  await page.addInitScript(fakeCapacitor);
  await page.goto(URL);
  await page.waitForSelector('#new-note');
  return { ctx, page, sent };
}

async function setDav(p) {
  await p.click('#sync-btn');
  if (await p.locator('#sync-dialog .web-only').isVisible()) fail('アプリ版なのに CORS の説明が出ている');
  await p.fill('#dav-url', DAV);
  await p.fill('#dav-user', 'test');
  await p.fill('#dav-pass', 'pass');
  await p.click('#dav-form button[type=submit]');
  await p.waitForFunction(() => /同期しました|失敗/.test(document.querySelector('#dav-form .sync-status').textContent), null, { timeout: 30000 });
  const s = await p.textContent('#dav-form .sync-status');
  await p.click('#sync-close');
  if (!/同期しました/.test(s)) fail('同期できない: ' + s);
  return s;
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    const A = await device(browser, { width: 412, height: 915 }, errors, 'A');
    const page = A.page;
    if (!(await page.evaluate(() => document.documentElement.classList.contains('native-android')))) fail('アプリ版の印(class)が付いていない');
    if ((await page.evaluate(() => navigator.serviceWorker.getRegistrations())).length) fail('アプリ版なのにサービスワーカーを登録した');
    if ((await page.getAttribute('#gn-input', 'accept')) !== '') fail('GoodNotes の取り込みで種類を絞っている');
    log('アプリ版として起動(サービスワーカーなし・取り込みの種類を絞らない)');

    // ノートを作って書く
    await page.click('#new-note');
    await page.click('#new-notebook');
    await page.fill('#nn-title', 'アプリのノート');
    await page.click('#new-form button[type=submit]');
    await page.waitForSelector('#pages svg');
    const bb = await page.locator('.page').first().boundingBox();
    await draw(page, [[bb.x + 40, bb.y + 120], [bb.x + 200, bb.y + 140], [bb.x + 300, bb.y + 110]]);
    await page.waitForTimeout(300);

    // 戻る: メニュー → ページ一覧(重ねて出ている) → ノートから本棚
    await page.click('#more-btn');
    await page.waitForSelector('.pop');
    await page.evaluate(() => window.__native.back());
    if (await page.locator('.pop').count()) fail('戻るでメニューが閉じない');
    await page.click('#pages-btn');
    await page.waitForSelector('#sidebar:not([hidden])');
    await page.evaluate(() => window.__native.back());
    if (await page.locator('#sidebar').isVisible()) fail('戻るでページ一覧が閉じない');
    if (!(await page.locator('#editor').isVisible())) fail('ページ一覧を閉じたつもりがノートから出てしまった');

    // PDF の書き出し: 端末に書いて共有シートへ
    await page.click('#more-btn');
    await page.click('#export-pdf');
    await page.waitForFunction(() => window.__native.shared.length === 1, null, { timeout: 30000 });
    const w = await page.evaluate(() => window.__native.written[0]);
    const sh = await page.evaluate(() => window.__native.shared[0]);
    if (!/^export\/アプリのノート\.pdf$/.test(w.path) || w.directory !== 'CACHE') fail('PDF の書き出し先がおかしい: ' + w.path);
    if (!Buffer.from(w.data, 'base64').subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('書き出した PDF が壊れている');
    if (sh.files[0] !== 'file:///cache/' + w.path) fail('共有シートに渡したファイルが違う');
    await page.waitForFunction(() => /PDFを書き出しました/.test(document.querySelector('#toast-msg').textContent));
    // 共有シートを閉じただけなら、エラーを出さない
    await page.evaluate(() => { window.__native.shareCancel = true; });
    await page.click('#more-btn');
    await page.click('#export-pdf');
    await page.waitForFunction(() => window.__native.written.length === 2, null, { timeout: 30000 });
    await page.waitForTimeout(300);
    if (/書き出せません/.test(await page.textContent('#toast-msg'))) fail('共有シートを閉じただけでエラーが出た');
    await page.evaluate(() => { window.__native.shareCancel = false; });
    log('PDF を共有シートで書き出せる(閉じただけならエラーなし)');

    await page.evaluate(() => window.__native.back());
    await page.waitForSelector('#library:not([hidden])');
    log('戻る: メニュー → ページ一覧 → 本棚 の順に閉じる');

    // 同期(OS の通信だけで送る)
    log('A:', await setDav(page));
    for (const m of ['MKCOL', 'PUT', 'PROPFIND']) if (!A.sent.includes(m)) fail(`${m} を送っていない`);

    // 同期ファイルの書き出しも共有シートで
    await page.click('#sync-btn');
    await page.click('#sync-export');
    await page.waitForFunction(() => window.__native.shared.length === 2);
    const sj = await page.evaluate(() => window.__native.written.at(-1));
    const json = JSON.parse(Buffer.from(sj.data, 'base64').toString('utf8'));
    if (!json.ops?.length) fail('同期ファイルが空');
    log('同期ファイルを共有シートで書き出せる(', json.ops.length, '件)');
    // 戻る: ダイアログを閉じる → 本棚ではアプリを裏に回す
    await page.evaluate(() => window.__native.back());
    if (await page.locator('#sync-dialog').isVisible()) fail('戻るでダイアログが閉じない');
    await page.evaluate(() => window.__native.back());
    if ((await page.evaluate(() => window.__native.minimized)) !== 1) fail('本棚で戻るを押してもアプリが裏に回らない');
    log('戻る: ダイアログを閉じ、本棚ではアプリを裏に回す');

    // 別の端末(タブレット)で受け取る
    const B = await device(browser, { width: 800, height: 1280 }, errors, 'B');
    log('B:', await setDav(B.page));
    await B.page.waitForSelector('.card:has-text("アプリのノート")');
    await B.page.click('.card:has-text("アプリのノート") .cover');
    await B.page.waitForSelector('.page path, .page svg path');
    log('端末 B にノートと線が届いた');

    if (errors.length) fail('エラー:\n' + errors.join('\n'));
    log('アプリ版の通し確認 おわり');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
