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
// テスト用サーバーには前の実行のノートが残っていることがあるので、毎回ちがう名前にする
const TITLE = 'アプリのノート' + Date.now().toString(36);
const fail = (m) => { throw new Error(m); };

// アプリの中身(プラグイン)のふり。約束は DavHttpPlugin.java・SaveFilePlugin.java・@capacitor/filesystem と同じ
const fakeCapacitor = () => {
  window.__native = { back: null, minimized: 0, files: {}, saved: [], saveCancel: false, removed: 0 };
  const up = {};
  const join = (parts) => { const bin = parts.map((b) => atob(b)).join(''); return btoa(bin); };
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    convertFileSrc: (p) => p,
    Plugins: {
      DavHttp: {
        writeChunk: async ({ id, data, append }) => { up[id] = append ? [...(up[id] || []), data] : [data]; },
        request: async (o) => {
          const body = o.bodyFile ? join(up[o.id] || []) : null;
          delete up[o.id];
          const r = await window.__nativeRequest({ ...o, body });
          const bin = atob(r.body);
          const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
          return { status: r.status, headers: r.headers, file: URL.createObjectURL(new Blob([bytes])), size: bytes.length };
        },
        remove: async () => { window.__native.removed++; },
        cancel: async () => {},
      },
      App: {
        addListener: async (ev, cb) => { if (ev === 'backButton') window.__native.back = cb; return { remove() {} }; },
        minimizeApp: async () => { window.__native.minimized++; },
      },
      Filesystem: {
        rmdir: async ({ path }) => { for (const k of Object.keys(window.__native.files)) if (k.startsWith(path + '/')) delete window.__native.files[k]; },
        writeFile: async (o) => { window.__native.files[o.path] = [o.data]; return { uri: 'file:///cache/' + o.path }; },
        appendFile: async (o) => { window.__native.files[o.path].push(o.data); },
      },
      SaveFile: {
        save: async (o) => {
          if (window.__native.saveCancel) { await new Promise((r) => setTimeout(r, 500)); return { saved: false }; } // 人が閉じるまでの間
          const path = o.path.replace('file:///cache/', '');
          window.__native.saved.push({ ...o, data: join(window.__native.files[path]) });
          return { saved: true };
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
  if (process.env.DEBUG) page.on('console', (m) => console.log(`  [${name}]`, m.text()));
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
    await page.fill('#nn-title', TITLE);
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

    // PDF の書き出し: 端末のキャッシュに書いて、保存先を選ぶ画面へ
    await page.click('#more-btn');
    await page.click('#export-pdf');
    await page.waitForFunction(() => window.__native.saved.length === 1, null, { timeout: 30000 });
    const sv = await page.evaluate(() => window.__native.saved[0]);
    if (sv.name !== `${TITLE}.pdf` || sv.mime !== 'application/pdf' || sv.path !== `file:///cache/export/${TITLE}.pdf`) fail('PDF の書き出し先がおかしい: ' + JSON.stringify({ ...sv, data: undefined }));
    if (!Buffer.from(sv.data, 'base64').subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('書き出した PDF が壊れている');
    await page.waitForFunction(() => /PDFを書き出しました/.test(document.querySelector('#toast-msg').textContent));
    // 選ぶ画面を閉じただけなら、何も出さない
    await page.evaluate(() => { window.__native.saveCancel = true; document.querySelector('#toast').hidden = true; });
    await page.click('#more-btn');
    await page.click('#export-pdf');
    // 「作成しています」は60秒出したままにする表示なので、5秒以内に消えれば「閉じた」の処理で消したもの
    await page.waitForFunction(() => /PDFを作成しています/.test(document.querySelector('#toast-msg').textContent) && !document.querySelector('#toast').hidden);
    await page.waitForFunction(() => document.querySelector('#toast').hidden, null, { timeout: 5000 });
    if (!/PDFを作成しています/.test(await page.textContent('#toast-msg'))) fail('選ぶ画面を閉じたのに、ほかの表示が出た: ' + (await page.textContent('#toast-msg')));
    await page.evaluate(() => { window.__native.saveCancel = false; });
    // 書き出しに失敗したら、エラーを出したままにする
    await page.evaluate(() => { window.__saveOrig = window.Capacitor.Plugins.SaveFile.save; window.Capacitor.Plugins.SaveFile.save = async () => { throw new Error('テストの失敗'); }; });
    await page.click('#more-btn');
    await page.click('#export-pdf');
    await page.waitForFunction(() => /書き出せませんでした/.test(document.querySelector('#toast-msg').textContent), null, { timeout: 30000 });
    await page.waitForTimeout(300);
    if (await page.locator('#toast').isHidden()) fail('書き出しの失敗が表示されない');
    await page.evaluate(() => { window.Capacitor.Plugins.SaveFile.save = window.__saveOrig; });
    log('PDF を保存先を選ぶ画面で書き出せる(閉じただけなら何も出さない・失敗は知らせる)');

    await page.evaluate(() => window.__native.back());
    await page.waitForSelector('#library:not([hidden])');
    log('戻る: メニュー → ページ一覧 → 本棚 の順に閉じる');

    // 同期(OS の通信だけで送る)
    log('A:', await setDav(page));
    for (const m of ['MKCOL', 'PUT', 'PROPFIND']) if (!A.sent.includes(m)) fail(`${m} を送っていない`);

    // 同期ファイルの書き出しも同じく
    await page.click('#sync-btn');
    await page.click('#sync-export');
    await page.waitForFunction(() => window.__native.saved.length === 2);
    const sj = await page.evaluate(() => window.__native.saved.at(-1));
    const json = JSON.parse(Buffer.from(sj.data, 'base64').toString('utf8'));
    if (!json.ops?.length) fail('同期ファイルが空');
    if ((await page.evaluate(() => Object.keys(window.__native.files).length)) !== 1) fail('前に書き出したファイルがキャッシュに残っている');
    log('同期ファイルも書き出せる(', json.ops.length, '件)。前に書き出したファイルは消す');
    // 戻る: ダイアログを閉じる → 本棚ではアプリを裏に回す
    await page.evaluate(() => window.__native.back());
    if (await page.locator('#sync-dialog').isVisible()) fail('戻るでダイアログが閉じない');
    await page.fill('#search', 'なにか');
    await page.waitForSelector('#results:not([hidden])');
    await page.evaluate(() => window.__native.back());
    if ((await page.inputValue('#search')) !== '' || (await page.evaluate(() => window.__native.minimized))) fail('戻るで検索が消えない');
    await page.evaluate(() => window.__native.back());
    if ((await page.evaluate(() => window.__native.minimized)) !== 1) fail('本棚で戻るを押してもアプリが裏に回らない');
    log('戻る: ダイアログを閉じ、本棚ではアプリを裏に回す');

    // 別の端末(タブレット)で受け取る
    const B = await device(browser, { width: 800, height: 1280 }, errors, 'B');
    log('B:', await setDav(B.page));
    await B.page.waitForSelector(`.card:has-text("${TITLE}")`);
    await B.page.click(`.card:has-text("${TITLE}") .cover`);
    await B.page.waitForSelector('.page path, .page svg path');
    log('端末 B にノートと線が届いた');

    if (errors.length) fail('エラー:\n' + errors.join('\n'));
    log('アプリ版の通し確認 おわり');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('✗', e.message, process.env.DEBUG ? e.stack : ''); process.exit(1); });
