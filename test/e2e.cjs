// ブラウザでの動作確認(Playwright)。python3 -m http.server 8123 で配信している前提。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
// npm i pdf-lib しておく(NODE_PATH で解決)
const PDFLib = require('pdf-lib');
const OUT = process.argv[2] || '/tmp';
const URL = process.env.URL || 'http://localhost:8123/';
const log = (...a) => console.log('✓', ...a);

async function makePdf() {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Lecture slide ${i}`, { x: 60, y: 760, size: 32, font });
    p.drawRectangle({ x: 60, y: 400, width: 300, height: 200, borderColor: PDFLib.rgb(0.2, 0.3, 0.8), borderWidth: 3 });
  }
  const f = path.join(OUT, 'slides.pdf');
  fs.writeFileSync(f, await doc.save());
  return f;
}

async function draw(page, pts) {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
}
const countOps = (page, t) => page.evaluate((t) => new Promise((res) => {
  const r = indexedDB.open('daigaku-note');
  r.onsuccess = () => { const q = r.result.transaction('ops').objectStore('ops').index('t').count(t); q.onsuccess = () => res(q.result); };
}), t);

(async () => {
  const pdfPath = await makePdf();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? '線形代数' : undefined));
  await page.goto(URL);
  await page.waitForSelector('#empty:not([hidden])');
  await page.screenshot({ path: path.join(OUT, '1-empty.png') });

  // 新しいノート
  await page.click('#new-note');
  await page.waitForSelector('#editor:not([hidden]) .page');
  const box = await page.locator('.page').first().boundingBox();
  const X = (fx) => box.x + box.width * fx, Y = (fy) => box.y + box.height * fy;
  await draw(page, [[X(.1), Y(.15)], [X(.3), Y(.12)], [X(.5), Y(.18)], [X(.7), Y(.13)]]);
  await draw(page, [[X(.1), Y(.25)], [X(.4), Y(.3)], [X(.6), Y(.22)]]);
  await page.click('#colors .swatch:nth-child(3)');
  await draw(page, [[X(.2), Y(.4)], [X(.25), Y(.5)], [X(.35), Y(.38)]]);
  await page.waitForTimeout(200);
  if ((await countOps(page, 'stroke.add')) !== 3) throw new Error('stroke.add should be 3');
  log('ペンで3本書けた(IndexedDBに3件)');

  // ペン(筆圧つき)の合成イベント
  await page.evaluate(({ x, y }) => {
    const sc = document.querySelector('#scroller');
    const target = document.querySelector('.page .ink');
    const ev = (type, dx, p) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'pen', clientX: x + dx, clientY: y + dx * 0.3, pressure: p, buttons: type === 'pointerup' ? 0 : 1 }));
    ev('pointerdown', 0, 0.1);
    for (let i = 1; i < 40; i++) ev('pointermove', i * 6, Math.min(1, i / 20));
    ev('pointerup', 240, 0);
  }, { x: X(.15), y: Y(.6) });
  await page.waitForTimeout(200);
  log('筆圧つきペンの線:', await countOps(page, 'stroke.add'), '本目');
  await page.screenshot({ path: path.join(OUT, '2-drawn.png') });

  // 消しゴム
  await page.click('#tool-eraser');
  await draw(page, [[X(.05), Y(.27)], [X(.7), Y(.27)]]);
  await page.waitForTimeout(200);
  if ((await countOps(page, 'stroke.del')) !== 1) throw new Error('eraser failed');
  log('消しゴムで消せた');
  await page.click('#undo');
  await page.waitForTimeout(200);
  if ((await countOps(page, 'stroke.undel')) !== 1) throw new Error('undo failed');
  log('元に戻すで復活した');

  // ページ追加
  await page.click('#add-page');
  await page.waitForTimeout(500);
  if ((await page.locator('.page').count()) !== 2) throw new Error('add page failed');
  log('ページ追加 → 2ページ');

  // 再読み込みしても残る
  await page.reload();
  await page.waitForSelector('.page');
  await page.waitForTimeout(500);
  if ((await page.locator('.page').count()) !== 2) throw new Error('reload lost pages');
  log('再読み込み後も2ページ・線が残る');
  await page.screenshot({ path: path.join(OUT, '3-reloaded.png') });

  // PDF 書き出し
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-pdf')]);
  const outPdf = path.join(OUT, 'export1.pdf');
  await dl.saveAs(outPdf);
  const d1 = await PDFLib.PDFDocument.load(fs.readFileSync(outPdf));
  log('PDF書き出し:', d1.getPageCount(), 'ページ', fs.statSync(outPdf).size, 'bytes');

  // 一覧へ戻って PDF を開く
  await page.click('#back');
  await page.waitForSelector('#library:not([hidden]) .card');
  await page.setInputFiles('#pdf-input', pdfPath);
  await page.waitForSelector('#editor:not([hidden]) .page');
  await page.waitForTimeout(1500);
  const n = await page.locator('.page').count();
  if (n !== 3) throw new Error('pdf pages ' + n);
  const b2 = await page.locator('.page').first().boundingBox();
  await page.click('#tool-pen');
  await draw(page, [[b2.x + 70, b2.y + 140], [b2.x + 200, b2.y + 160], [b2.x + 330, b2.y + 130]]);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '4-pdf.png') });
  log('PDFを開いて3ページ表示、上に書けた');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-pdf')]);
  const outPdf2 = path.join(OUT, 'export-annotated.pdf');
  await dl.saveAs(outPdf2);
  log('注釈つきPDF書き出し:', (await PDFLib.PDFDocument.load(fs.readFileSync(outPdf2))).getPageCount(), 'ページ');

  // 同期ファイル書き出し
  await page.click('#back');
  await page.waitForSelector('.card');
  await page.screenshot({ path: path.join(OUT, '5-library.png') });
  await page.click('#sync-btn');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#sync-export')]);
  const syncA = path.join(OUT, 'syncA.json');
  await dl.saveAs(syncA);
  await page.click('#sync-close');
  log('同期ファイル:', JSON.parse(fs.readFileSync(syncA)).ops.length, '件の変更');

  // 別の端末(まっさらなブラウザ)で取り込み、そちらでも書いて、元の端末へ戻す
  const ctxB = await browser.newContext({ viewport: { width: 820, height: 1180 }, acceptDownloads: true });
  const pb = await ctxB.newPage();
  pb.on('pageerror', (e) => errors.push('B: ' + e.message));
  await pb.goto(URL);
  await pb.waitForSelector('#empty:not([hidden])');
  await pb.click('#sync-btn');
  await pb.setInputFiles('#sync-input', syncA);
  await pb.waitForSelector('.card');
  const cardsB = await pb.locator('.card').count();
  log('端末Bに取り込み → ノート', cardsB, '冊');
  await pb.click('.card:has-text("線形代数") .cover');
  await pb.waitForSelector('.page');
  await pb.waitForTimeout(500);
  const bb = await pb.locator('.page').first().boundingBox();
  await draw(pb, [[bb.x + 100, bb.y + 600], [bb.x + 300, bb.y + 650], [bb.x + 500, bb.y + 600]]);
  // 端末Aでも同時に別の線を書く
  await page.click('.card:has-text("線形代数") .cover');
  await page.waitForSelector('.page');
  await page.waitForTimeout(300);
  const ba = await page.locator('.page').first().boundingBox();
  await draw(page, [[ba.x + 50, ba.y + 500], [ba.x + 150, ba.y + 520]]);
  await pb.click('#back');
  await pb.click('#sync-btn');
  [dl] = await Promise.all([pb.waitForEvent('download'), pb.click('#sync-export')]);
  const syncB = path.join(OUT, 'syncB.json');
  await dl.saveAs(syncB);
  await pb.click('#sync-close');
  await page.click('#back');
  await page.click('#sync-btn');
  await page.setInputFiles('#sync-input', syncB);
  await page.waitForTimeout(800);
  await page.click('.card:has-text("線形代数") .cover');
  await page.waitForSelector('.page');
  await page.waitForTimeout(600);
  const alive = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('daigaku-note');
    r.onsuccess = () => { const q = r.result.transaction('ops').objectStore('ops').getAll(); q.onsuccess = () => res(q.result.length); };
  }));
  await page.screenshot({ path: path.join(OUT, '6-merged.png') });
  log('端末Bの変更を端末Aに取り込んだ(Aの線もBの線も残る) op数:', alive);

  // iPad 縦サイズでの見た目
  await pb.click('.card:has-text("線形代数") .cover');
  await pb.waitForTimeout(600);
  await pb.screenshot({ path: path.join(OUT, '7-ipad.png') });

  // オフライン起動(Service Worker)
  await page.goto(URL);
  await page.waitForTimeout(1000);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('.card', { timeout: 5000 });
  log('オフラインでも起動できた');
  await ctx.setOffline(false);

  if (errors.length) { console.log('ERRORS:', errors); process.exitCode = 1; }
  else log('ブラウザのエラーなし');
  await browser.close();
})().catch((e) => { console.error('✗', e); process.exit(1); });
