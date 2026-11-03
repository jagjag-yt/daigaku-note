// 筆圧で太さが変わるかの確認。
//   URL=http://localhost:8124/ node test/pressure.cjs <画像の出力先>
// 1) pointer の pressure が本物の機器(Windows のペンなど)
// 2) iPad Safari のように pointer の pressure が 0.5 のままで、タッチの force にだけ筆圧が来る機器
// 3) 筆圧のない機器(pressure 0.5 だけ) → 今までどおり一定の太さ(pr: true)
// 4) 筆圧をオフにしたとき → 一定の太さ
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const results = {};
  let shotDone = false;
  for (const mode of ['pointer', 'touchforce', 'none', 'off']) {
    const page = await (await b.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2, hasTouch: true })).newPage();
    page.on('pageerror', (e) => errs.push(mode + ': ' + e.message));
    await page.goto(process.env.URL + '?debug');
    await page.click('#new-note'); await page.click('#new-notebook'); await page.fill('#nn-title', 't'); await page.click('#new-form button[type=submit]');
    await page.waitForSelector('#editor:not([hidden]) .page'); await page.waitForTimeout(300);
    if (mode === 'off') { await page.click('#more-btn'); await page.click('#pressure'); await page.waitForTimeout(100); }
    const box = await page.locator('.page').first().boundingBox();
    await page.evaluate(async ({ x, y, mode }) => {
      const t = document.querySelector('.page .ink');
      // Chromium の Touch には touchType がないので、Safari と同じく 'stylus' を返すようにする
      if (!('touchType' in Touch.prototype)) Object.defineProperty(Touch.prototype, 'touchType', { get: () => 'stylus' });
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const pe = (type, cx, cy, p) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', clientX: cx, clientY: cy, pressure: p, buttons: type === 'pointerup' ? 0 : 1 }));
      const te = (type, cx, cy, f) => {
        const touch = new Touch({ identifier: 7, target: t, clientX: cx, clientY: cy, force: f, touchType: 'stylus' });
        t.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch], changedTouches: [touch] }));
      };
      // 筆圧: 弱 → 強 → 弱
      const N = 100;
      const press = (i) => 0.05 + 0.9 * Math.sin((i / N) * Math.PI);
      for (let i = 0; i <= N; i++) {
        const cx = x + i * 4, cy = y + Math.sin(i / 12) * 10;
        const real = press(i);
        const pp = mode === 'pointer' ? real : 0.5;
        if (i === 0) pe('pointerdown', cx, cy, pp);
        else pe('pointermove', cx, cy, pp);
        if (mode === 'touchforce') te(i === 0 ? 'touchstart' : 'touchmove', cx, cy, real);
        await sleep(4);
      }
      pe('pointerup', x + N * 4, y, 0);
      if (mode === 'touchforce') te('touchend', x + N * 4, y, 0);
    }, { x: box.x + 60, y: box.y + 120, mode });
    await page.waitForTimeout(300);
    results[mode] = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('daigaku-note'); r.onsuccess = () => { const q = r.result.transaction('ops').objectStore('ops').getAll(); q.onsuccess = () => { const s = q.result.filter((o) => o.t === 'stroke.add').map((o) => o.p.s)[0]; const ps = s.pts.filter((_, i) => i % 3 === 2); res({ pr: s.pr, n: ps.length, min: Math.min(...ps), max: Math.max(...ps) }); }; }; }));
    results[mode].debug = (await page.textContent('#debug-box')).split('\n').filter((l) => l.includes('touch.force')).join(' ');
    if (!shotDone && mode === 'touchforce') { await page.screenshot({ path: process.argv[2], clip: { x: box.x + 40, y: box.y + 90, width: 460, height: 70 } }); shotDone = true; }
    await page.close();
  }
  console.log(JSON.stringify(results, null, 1), 'errors', errs);
  const ok = results.pointer.pr === 2 && results.pointer.max - results.pointer.min > 0.5
    && results.touchforce.pr === 2 && results.touchforce.max - results.touchforce.min > 0.5
    && results.none.pr === true && results.none.min === 0.5 && results.none.max === 0.5
    && results.off.pr === true && results.off.max === 0.5 && !errs.length;
  console.log(ok ? 'OK' : 'NG');
  await b.close();
  process.exit(ok ? 0 : 1);
})();
