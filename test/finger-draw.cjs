// 「指で書く」の自動: ペンを使うまでは指で書け、2本指ではスクロールになり、ペンを使ったら指はスクロールになるかの確認。
//   URL=http://localhost:8124/ node test/finger-draw.cjs
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const page = await (await b.newContext({ viewport: { width: 800, height: 700 }, hasTouch: true })).newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(process.env.URL);
  await page.locator('#auth .auth-skip:visible').first().click();
  await page.click('#new-note'); await page.click('#new-notebook'); await page.fill('#nn-title', 't'); await page.click('#new-form button[type=submit]');
  await page.waitForSelector('#editor:not([hidden]) .page'); await page.waitForTimeout(300);
  const box = await page.locator('.page').first().boundingBox();
  const strokes = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('daigaku-note'); r.onsuccess = () => { const q = r.result.transaction('ops').objectStore('ops').getAll(); q.onsuccess = () => res(q.result.filter((o) => o.t === 'stroke.add').length); }; }));
  const top = () => page.evaluate(() => document.querySelector('#scroller').scrollTop);
  const run = (steps) => page.evaluate(async ({ steps, x, y }) => {
    const t = document.querySelector('.page .ink');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const [type, id, kind, dx, dy, wait] of steps) {
      t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: kind, clientX: x + dx, clientY: y + dy, pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1 }));
      if (wait) await sleep(wait);
    }
  }, { steps, x: box.x + 100, y: box.y + 150 });
  const line = (id, kind, y0 = 0) => [['pointerdown', id, kind, 0, y0, 10], ...Array.from({ length: 15 }, (_, i) => ['pointermove', id, kind, i * 8, y0, 10]), ['pointerup', id, kind, 120, y0, 200]];
  const res = {};
  // 1. 指1本で書ける
  await run(line(1, 'touch'));
  res.finger = await strokes();
  // 2. 指で書き始めてすぐ2本目の指: 書きかけは取り消し、2本指で上へ動かすとスクロール
  const t0 = await top();
  await run([['pointerdown', 2, 'touch', 0, 100, 30], ['pointermove', 2, 'touch', 5, 100, 30], ['pointerdown', 3, 'touch', 60, 100, 20],
    ...Array.from({ length: 10 }, (_, i) => [['pointermove', 2, 'touch', 5, 100 - i * 15, 0], ['pointermove', 3, 'touch', 60, 100 - i * 15, 15]]).flat(),
    ['pointerup', 2, 'touch', 5, -50, 0], ['pointerup', 3, 'touch', 60, -50, 300]]);
  res.twoFinger = await strokes();
  res.scrolled = (await top()) - t0;
  // 3. 2本指でスクロールして1本を離し、置き直しても線は書かない(残った指と一緒にスクロール)
  await run([['pointerdown', 6, 'touch', 0, 100, 30], ['pointerdown', 7, 'touch', 60, 100, 30],
    ['pointermove', 6, 'touch', 0, 80, 10], ['pointermove', 7, 'touch', 60, 80, 10], ['pointerup', 7, 'touch', 60, 80, 30],
    ['pointerdown', 8, 'touch', 60, 80, 30], ...Array.from({ length: 8 }, (_, i) => ['pointermove', 8, 'touch', 60 + i * 8, 80, 10]),
    ['pointerup', 8, 'touch', 120, 80, 0], ['pointerup', 6, 'touch', 0, 80, 300]]);
  res.replaced = await strokes();
  // 4. 初めてペンを使ったとき、先に触れていた手のひらの線は残さず、ペンの線を書く
  await run([['pointerdown', 9, 'touch', 200, 120, 20], ['pointermove', 9, 'touch', 205, 125, 20],
    ...line(4, 'pen', 40), ['pointerup', 9, 'touch', 205, 125, 300]]);
  res.pen = await strokes();
  res.penTool = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('daigaku-note'); r.onsuccess = () => { const q = r.result.transaction('ops').objectStore('ops').getAll(); q.onsuccess = () => { const a = q.result.filter((o) => o.t === 'stroke.add'); res(a[a.length - 1].p.s.pts.length > 30); }; }; }));
  res.toast = await page.textContent('#toast-msg');
  await run(line(5, 'touch', 80));
  res.fingerAfterPen = await strokes();
  console.log(JSON.stringify(res), errs);
  const ok = res.finger === 1 && res.twoFinger === 1 && res.scrolled > 50 && res.replaced === 1 && res.pen === 2 && res.penTool && /ペンを使ったので/.test(res.toast) && res.fingerAfterPen === 2 && !errs.length;
  await b.close();
  process.exit(ok ? 0 : 1);
})();
