// ペンの入力が途中で途切れても1本の線になるか、手のひらでスクロールしないかの確認。
//   URL=http://localhost:8124/ node test/pen-join.cjs <画像の出力先>
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const page = await (await b.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 3, hasTouch: true })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(process.env.URL + '?debug');
  await page.click('#new-note'); await page.fill('#nn-title', 't'); await page.click('#new-form button[type=submit]');
  await page.waitForSelector('#editor:not([hidden]) .page'); await page.waitForTimeout(300);
  const box = await page.locator('.page').first().boundingBox();
  const top0 = await page.evaluate(() => document.querySelector('#scroller').scrollTop);
  await page.evaluate(async ({ x, y }) => {
    const t = document.querySelector('.page .ink');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const ev = (type, id, kind, cx, cy, p) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: kind, clientX: cx, clientY: cy, pressure: p, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1 }));
    // 線1: 途中で手のひらが触れて pointercancel → 20ms 後に別IDで再開
    ev('pointerdown', 1, 'pen', x, y, 0.5);
    let id = 1;
    for (let i = 1; i <= 120; i++) {
      if (i % 40 === 0) { ev('pointercancel', id, 'pen', x + i * 3, y, 0); await sleep(20); id++; ev('pointerdown', id, 'pen', x + i * 3 + 2, y, 0.5); }
      if (i === 30) ev('pointerdown', 50, 'touch', x + 200, y + 200, 0.5);
      if (i > 30 && i < 60) ev('pointermove', 50, 'touch', x + 200, y + 200 - (i - 30) * 5, 0.5);
      ev('pointermove', id, 'pen', x + i * 3, y + Math.sin(i / 10) * 5, 0.5);
      await sleep(4);
    }
    ev('pointerup', id, 'pen', x + 363, y, 0);
    ev('pointerup', 50, 'touch', x + 200, y + 50, 0);
    await sleep(400);
    // 線2,3: 本当にペンを離す(40ms ですぐ次を書いても別の線)
    for (let k = 0; k < 2; k++) {
      ev('pointerdown', 10 + k, 'pen', x, y + 60 + k * 10, 0.5);
      for (let i = 1; i < 20; i++) ev('pointermove', 10 + k, 'pen', x + i * 3, y + 60 + k * 10, 0.5);
      ev('pointerup', 10 + k, 'pen', x + 60, y + 60 + k * 10, 0);
      await sleep(40);
    }
  }, { x: box.x + 60, y: box.y + 120 });
  await page.waitForTimeout(300);
  const n = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('daigaku-note'); r.onsuccess = () => { const q = r.result.transaction('ops').objectStore('ops').getAll(); q.onsuccess = () => res(q.result.filter(o => o.t === 'stroke.add').map(o => o.p.s.pts.length / 3)); }; }));
  const top1 = await page.evaluate(() => document.querySelector('#scroller').scrollTop);
  console.log('strokes(points):', n, 'scrolled by palm:', top1 - top0, 'debug:', await page.textContent('#debug-box'), 'errors', errs);
  await page.screenshot({ path: process.argv[2], clip: { x: box.x + 40, y: box.y + 90, width: 420, height: 120 } });
  await b.close();
})();
