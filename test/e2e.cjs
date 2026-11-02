// ブラウザでの通し確認(Playwright)。
//   node serve.mjs 8124 &  /  node test/davserver.mjs 8125 &
//   URL=http://localhost:8124/ GN=見本.goodnotes node test/e2e.cjs <出力フォルダ>
// pdf-lib と playwright は NODE_PATH などで解決できるようにしておく。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PDFLib = require('pdf-lib');
const OUT = process.argv[2] || '/tmp';
const URL = process.env.URL || 'http://localhost:8124/';
const DAV = process.env.DAV || 'http://localhost:8125/dav/';
const GN = process.env.GN;
const log = (...a) => console.log('✓', ...a);
const shot = (p, n) => p.screenshot({ path: path.join(OUT, n) });

async function makePdf() {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Lecture slide ${i} membrane potential`, { x: 60, y: 760, size: 24, font });
  }
  const f = path.join(OUT, 'slides.pdf');
  fs.writeFileSync(f, await doc.save());
  return f;
}

async function draw(page, pts, { hold = 0, steps = 4 } = {}) {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps });
  if (hold) await page.waitForTimeout(hold);
  await page.mouse.up();
}
const idb = (page, fn) => page.evaluate((src) => new Promise((res) => {
  const r = indexedDB.open('daigaku-note');
  r.onsuccess = () => { const q = r.result.transaction('ops').objectStore('ops').getAll(); q.onsuccess = () => res(new Function('ops', src)(q.result)); };
}), fn);
const countT = (page, t) => idb(page, `return ops.filter(o => o.t === ${JSON.stringify(t)}).length`);

(async () => {
  const pdfPath = await makePdf();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(URL);
  await page.waitForSelector('#empty:not([hidden])');

  // 新しいノート(方眼・A4横)
  await page.click('#new-note');
  await page.fill('#nn-title', '神経生理学');
  await page.selectOption('#nn-tpl', 'grid');
  await page.selectOption('#nn-size', 'a4l');
  await page.click('#new-form button[type=submit]');
  await page.waitForSelector('#editor:not([hidden]) .page');
  const box = await page.locator('.page').first().boundingBox();
  if (box.width < box.height) throw new Error('A4横になっていない');
  log('新しいノート: 方眼・A4横で作成');
  const X = (fx) => box.x + box.width * fx, Y = (fy) => box.y + box.height * fy;

  // ペン(手書き風の曲線)
  const wave = [];
  for (let i = 0; i <= 30; i++) wave.push([X(0.05 + i * 0.012), Y(0.15 + Math.sin(i / 3) * 0.04)]);
  await draw(page, wave, { steps: 2 });
  // 筆圧つきペン
  await page.evaluate(({ x, y }) => {
    const t = document.querySelector('.page .ink');
    const ev = (type, i, p) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'pen', clientX: x + i * 5, clientY: y + Math.sin(i / 4) * 30, pressure: p, buttons: type === 'pointerup' ? 0 : 1 }));
    ev('pointerdown', 0, 0.05);
    for (let i = 1; i < 60; i++) ev('pointermove', i, Math.sin((i / 60) * Math.PI));
    ev('pointerup', 60, 0);
  }, { x: X(0.5), y: Y(0.15) });
  await page.waitForTimeout(200);
  log('ペン:', await countT(page, 'stroke.add'), '本(マウス1・筆圧つき1)');

  // 図形補正: 円を描いてペンを止める
  const circ = [];
  for (let i = 0; i <= 36; i++) circ.push([X(0.25) + Math.cos(i / 36 * 6.28) * 60 * (1 + 0.08 * Math.sin(i)), Y(0.45) + Math.sin(i / 36 * 6.28) * 55]);
  await draw(page, circ, { hold: 900, steps: 1 });
  // 四角形
  await draw(page, [[X(0.45), Y(0.35)], [X(0.6), Y(0.352)], [X(0.601), Y(0.55)], [X(0.452), Y(0.548)], [X(0.45), Y(0.352)]], { hold: 900, steps: 6 });
  await page.waitForTimeout(200);
  const shapes = await idb(page, "return ops.filter(o => o.t === 'stroke.add' && o.p.s.shape).map(o => o.p.s.shape)");
  if (!shapes.includes('circle') && !shapes.includes('ellipse')) throw new Error('円の補正に失敗 ' + shapes);
  if (!shapes.includes('rect')) throw new Error('四角の補正に失敗 ' + shapes);
  log('図形補正:', shapes.join(', '));

  // 蛍光ペン
  await page.click('#tool-marker');
  await draw(page, [[X(0.04), Y(0.15)], [X(0.4), Y(0.15)]]);
  await page.waitForTimeout(150);
  const marker = await idb(page, "return ops.filter(o => o.t === 'stroke.add' && o.p.s.tool === 'marker').length");
  if (marker !== 1) throw new Error('蛍光ペン');
  log('蛍光ペン');
  await shot(page, 'v2-1-ink.png');

  // 投げ縄で円を囲んで移動
  await page.click('#tool-lasso');
  await draw(page, [[X(0.15), Y(0.3)], [X(0.35), Y(0.3)], [X(0.35), Y(0.6)], [X(0.15), Y(0.6)], [X(0.15), Y(0.3)]]);
  await page.waitForSelector('.sel-box');
  const selText = await page.textContent('.sel-bar span');
  await draw(page, [[X(0.25), Y(0.45)], [X(0.3), Y(0.7)]]);
  await page.waitForTimeout(200);
  if ((await countT(page, 'stroke.tf')) !== 1) throw new Error('移動できていない');
  log('投げ縄:', selText, '→ 移動できた');
  await page.click('.sel-bar [data-a=dup]');
  await page.waitForTimeout(200);
  await shot(page, 'v2-2-lasso.png');
  await page.click('.sel-bar [data-a=off]');
  log('複製もできた');
  await page.click('#undo');
  await page.waitForTimeout(150);
  await page.click('#tool-pen');

  // ページ: 追加 → 並べ替え → テンプレート変更
  await page.click('#pages-btn');
  await page.selectOption('#pp-tpl', 'music');
  await page.selectOption('#pp-size', 'a4');
  await page.click('#pp-add');
  await page.waitForTimeout(400);
  const rows = await page.locator('.pp-row').count();
  await page.locator('.pp-row').nth(1).locator('[data-a=up]').click();
  await page.waitForTimeout(300);
  await page.locator('.pp-row').nth(1).locator('.pp-tpl').selectOption('dots');
  await page.waitForTimeout(300);
  await shot(page, 'v2-3-pages.png');
  await page.click('#pages-close');
  if (rows !== 2 || (await countT(page, 'page.move')) !== 1 || (await countT(page, 'page.bg')) !== 1) throw new Error('ページ操作');
  log('ページ: 五線譜を追加 → 先頭へ移動 → 2ページ目をドットに変更');

  // PDF 書き出し(ベクター)
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-pdf')]);
  const out1 = path.join(OUT, 'v2-export.pdf');
  await dl.saveAs(out1);
  log('PDF書き出し:', (await PDFLib.PDFDocument.load(fs.readFileSync(out1))).getPageCount(), 'ページ');

  // 再読み込み
  await page.reload();
  await page.waitForSelector('.page');
  await page.waitForTimeout(600);
  await shot(page, 'v2-4-reload.png');
  log('再読み込み後も残る');

  // PDF を開く → PDF の文字で検索
  await page.click('#back');
  await page.waitForSelector('.card');
  await page.setInputFiles('#pdf-input', pdfPath);
  await page.waitForSelector('#editor:not([hidden]) .page');
  await page.waitForTimeout(800);
  await page.click('#back');
  await page.waitForTimeout(7000); // 認識待ち
  await page.fill('#search', 'membrane');
  await page.waitForTimeout(600);
  const pdfHits = await page.locator('.hit').count();
  if (!pdfHits) throw new Error('PDFの文字で検索できない');
  log('検索: PDFの文字「membrane」→', pdfHits, '件');
  await page.fill('#search', '');

  // GoodNotes の取り込み
  if (GN) {
    await page.setInputFiles('#gn-input', GN);
    await page.waitForSelector('#editor:not([hidden]) .page', { timeout: 60000 });
    await page.waitForTimeout(1500);
    await shot(page, 'v2-5-goodnotes.png');
    const n = await page.locator('.page').count();
    const title = await page.textContent('#title');
    log('GoodNotes取り込み:', title, n, 'ページ', await countT(page, 'stroke.add'), '本(累計)');
    await page.locator('.page').nth(n - 1).scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await shot(page, 'v2-6-goodnotes-last.png');
    // 手書き文字の認識を待って検索
    await page.click('#back');
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(2000);
      const st = await page.textContent('#search-status');
      if (!st) break;
      if (i % 10 === 0) console.log('  ', st);
    }
    const sample = await page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('daigaku-note');
      r.onsuccess = () => { const q = r.result.transaction('search').objectStore('search').getAll(); q.onsuccess = () => res(q.result.filter((x) => x.ink).map((x) => x.ink.slice(0, 80))); };
    }));
    console.log('  認識結果の例:', sample.slice(0, 3));
    log('手書き文字の認識:', sample.length, 'ページ分');
  }

  // クラウド同期(WebDAV): 端末Aから送り、端末Bで受け取り、Bの変更をAへ
  const setDav = async (p) => {
    await p.click('#sync-btn');
    await p.fill('#dav-url', DAV);
    await p.fill('#dav-user', 'test');
    await p.fill('#dav-pass', 'pass');
    await p.click('#dav-form button[type=submit]');
    await p.waitForFunction(() => /同期しました|失敗/.test(document.querySelector('#dav-form .sync-status').textContent), null, { timeout: 30000 });
    const s = await p.textContent('#dav-form .sync-status');
    await p.click('#sync-close');
    return s;
  };
  console.log('  A:', await setDav(page));
  const ctxB = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  const pb = await ctxB.newPage();
  pb.on('pageerror', (e) => errors.push('B: ' + e.message));
  pb.on('dialog', (d) => d.accept());
  await pb.goto(URL);
  await pb.waitForSelector('#empty:not([hidden])');
  console.log('  B:', await setDav(pb));
  await pb.waitForSelector('.card');
  const cardsB = await pb.locator('.card').count();
  log('WebDAV: 端末Bに', cardsB, '冊届いた');
  await pb.click('.card:has-text("神経生理学") .cover');
  await pb.waitForSelector('.page');
  await pb.waitForTimeout(500);
  const bb = await pb.locator('.page').nth(0).boundingBox();
  await draw(pb, [[bb.x + 60, bb.y + 400], [bb.x + 300, bb.y + 380], [bb.x + 500, bb.y + 420]]);
  await pb.waitForTimeout(6500); // 自動同期(変更の数秒後)
  await page.click('#sync-btn');
  await page.click('#dav-form button[type=submit]');
  await page.waitForTimeout(2500);
  await page.click('#sync-close');
  const fromB = await idb(page, `return ops.filter(o => o.d !== ops.find(x => x.t === 'note.create').d).length`);
  if (fromB < 1) throw new Error('端末Bの変更が届いていない');
  log('WebDAV: 端末Bで書いた線が端末Aに自動で届いた');
  await pb.screenshot({ path: path.join(OUT, 'v2-7-ipad.png') });

  if (errors.length) { console.log('ERRORS:', errors); process.exitCode = 1; }
  else log('ブラウザのエラーなし');
  await browser.close();
})().catch((e) => { console.error('✗', e); process.exit(1); });
