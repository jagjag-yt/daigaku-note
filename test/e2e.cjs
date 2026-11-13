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
let gnTitle = null; // 画像入りの GoodNotes を取り込んだときのノート名(同期の確認用)

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

// jitter: 止めている間もペン先が揺れて点が届き続ける様子(実機の iPad + Pencil)をまねる
async function draw(page, pts, { hold = 0, steps = 4, jitter = 0 } = {}) {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps });
  if (hold && jitter) {
    const [lx, ly] = pts[pts.length - 1];
    for (let t = 0; t < hold; t += 25) {
      await page.mouse.move(lx + Math.sin(t / 40) * jitter, ly + Math.cos(t / 55) * jitter);
      await page.waitForTimeout(25);
    }
  } else if (hold) await page.waitForTimeout(hold);
  await page.mouse.up();
}
const idb = (page, fn) => page.evaluate((src) => new Promise((res) => {
  const r = indexedDB.open('daigaku-note');
  r.onsuccess = () => { const q = r.result.transaction('ops').objectStore('ops').getAll(); q.onsuccess = () => res(new Function('ops', src)(q.result)); };
}), fn);
// 線を書いた順に(op の id は文字列なので並び順が書いた順にならない。ランポート時計で並べる)
const STROKES = "const s = ops.filter(o => o.t === 'stroke.add').sort((a, b) => a.l - b.l).map(o => o.p.s);";
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
  await page.click('#new-notebook');
  await page.fill('#nn-title', '神経生理学');
  await page.click('#nn-tpl [data-tpl=grid]');
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

  // 図形補正: 既定はオフ。オフのまま円を描いて止めても整えない
  const circ = [];
  for (let i = 0; i <= 36; i++) circ.push([X(0.25) + Math.cos(i / 36 * 6.28) * 60 * (1 + 0.08 * Math.sin(i)), Y(0.45) + Math.sin(i / 36 * 6.28) * 55]);
  const shapesNow = () => idb(page, "return ops.filter(o => (o.t === 'stroke.add' || o.t === 'item.add') && o.p.s.shape).map(o => o.p.s.shape)");
  if (await page.getAttribute('#shapes', 'aria-pressed') !== 'false') throw new Error('図形補正が既定でオンになっている');
  await draw(page, circ.map(([x, y]) => [x + box.width * 0.55, y]), { hold: 900, steps: 1 });
  await page.waitForTimeout(200);
  if ((await shapesNow()).length) throw new Error('図形補正がオフなのに整えた');
  await page.click('#shapes');
  if (await page.getAttribute('#shapes', 'aria-pressed') !== 'true') throw new Error('図形補正をオンにできない');
  // 円を描いてペンを止める(止めている間もペン先が揺れている)
  await draw(page, circ, { hold: 900, steps: 1, jitter: 1.5 });
  // 三角形・五角形: 止めずにすぐ離しても整う
  await draw(page, [[X(0.66), Y(0.3)], [X(0.6), Y(0.45)], [X(0.72), Y(0.45)], [X(0.661), Y(0.302)]], { steps: 8 });
  const pent = [];
  for (let i = 0; i <= 5; i++) { const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5; pent.push([X(0.85) + Math.cos(a) * 50, Y(0.6) + Math.sin(a) * 50]); }
  await draw(page, pent, { steps: 8 });
  // 曲線(半円): すぐ離すと弧に整う
  const half = [];
  for (let i = 0; i <= 20; i++) { const a = Math.PI + (i / 20) * Math.PI; half.push([X(0.3) + Math.cos(a) * 60, Y(0.85) + Math.sin(a) * 60]); }
  await draw(page, half, { steps: 4 });
  // 四角形(辺の途中から書き始める)
  await draw(page, [[X(0.52), Y(0.352)], [X(0.6), Y(0.352)], [X(0.601), Y(0.55)], [X(0.452), Y(0.548)], [X(0.45), Y(0.352)], [X(0.52), Y(0.353)]], { hold: 900, steps: 6, jitter: 1.5 });
  await page.waitForTimeout(200);
  const shapes = await shapesNow();
  if (!shapes.includes('circle') && !shapes.includes('ellipse')) throw new Error('円の補正に失敗 ' + shapes);
  if (!shapes.includes('rect')) throw new Error('四角の補正に失敗 ' + shapes);
  if (!shapes.includes('triangle')) throw new Error('すぐ離した三角の補正に失敗 ' + shapes);
  if (!shapes.includes('polygon')) throw new Error('すぐ離した五角形の補正に失敗 ' + shapes);
  if (!shapes.includes('arc')) throw new Error('すぐ離した半円の補正に失敗 ' + shapes);
  log('図形補正: 既定オフ、オンにすると', shapes.join(', '));
  // 書いている途中で止まっただけ(L字): 一度直線に整っても、続けて書けば元の線に戻って続きが足される
  await draw(page, [[X(0.7), Y(0.7)], [X(0.85), Y(0.7)]], { hold: 800, steps: 12, jitter: 1.5 });
  // L字(draw は止めたあとすぐ離すので、ここは自前で書く)。離したときに L 全体が折れ線に整うのはよい
  await page.mouse.move(X(0.7), Y(0.8));
  await page.mouse.down();
  await page.mouse.move(X(0.85), Y(0.8), { steps: 12 });
  for (let t = 0; t < 800; t += 25) { await page.mouse.move(X(0.85) + Math.sin(t / 40) * 1.5, Y(0.8)); await page.waitForTimeout(25); }
  await page.mouse.move(X(0.85), Y(0.95), { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const last = await idb(page, STROKES + "return s.slice(-2).map(d => ({ shape: d.shape || '-', maxY: Math.max(...d.pts.filter((_, i) => i % 3 === 1)) }))");
  if (last[0].shape !== 'line') throw new Error('止めた直線が整わない ' + JSON.stringify(last));
  // 直線は高さ 0.7、L字は 0.95 まで下りている(どちらもページ上端からの比)
  if (!['-', 'polyline'].includes(last[1].shape) || last[1].maxY / last[0].maxY < 1.25) throw new Error('途中で止めたあとの続きが消えた ' + JSON.stringify(last));
  log('図形補正: 途中で止めただけなら元に戻り、続きも残る');
  // ペンの入力が途中で止められて(pointercancel)つないだあとに止めても整う
  await page.evaluate(async ({ x, y }) => {
    const t = document.querySelector('.page .ink');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ev = (type, id, cx, cy) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'pen', clientX: cx, clientY: cy, pressure: 0.5, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1 }));
    ev('pointerdown', 71, x, y);
    for (let i = 1; i <= 40; i++) { ev('pointermove', 71, x + i * 4, y + 0.3); await sleep(8); }
    await sleep(200);
    ev('pointercancel', 71, x + 160, y);
    await sleep(30);
    ev('pointerdown', 72, x + 160.5, y);
    for (let i = 0; i < 36; i++) { ev('pointermove', 72, x + 160 + Math.sin(i) * 1.2, y + Math.cos(i) * 1.2); await sleep(25); }
    ev('pointerup', 72, x + 160, y);
    await sleep(500);
  }, { x: X(0.05), y: Y(0.9) });
  const lastPen = await idb(page, STROKES + "return s[s.length - 1].shape || '-'");
  if (lastPen !== 'line') throw new Error('つないだあとに止めても整わない ' + lastPen);
  log('図形補正: 途切れてつないだ線でも整う');

  // 蛍光ペン
  await page.click('#tool-marker');
  await draw(page, [[X(0.04), Y(0.15)], [X(0.2), Y(0.158)], [X(0.4), Y(0.15)]], { hold: 700 });
  await page.waitForTimeout(150);
  const marker = await idb(page, "return ops.filter(o => (o.t === 'stroke.add' || o.t === 'item.add') && o.p.s.tool === 'marker').map(o => o.p.s.shape || '-')");
  if (marker.length !== 1) throw new Error('蛍光ペン');
  if (marker[0] !== 'line') throw new Error('蛍光ペンの直線の補正に失敗 ' + marker);
  log('蛍光ペン(止めると直線に整う)');
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
  await page.click('#sb-add');
  await page.click('#pp-tpl [data-tpl=music]');
  await page.selectOption('#pp-size', 'a4');
  await page.check('input[name=pp-where][value=last]', { force: true });
  await page.click('#pp-add');
  await page.waitForTimeout(400);
  const rows = await page.locator('.pp-row').count();
  await page.locator('.pp-row').nth(1).locator('.pp-menu').click();
  await page.click('.pop [data-a=up]');
  await page.waitForTimeout(300);
  await page.locator('.pp-row').nth(1).locator('.pp-menu').click();
  await page.locator('.pop .pp-tpl').selectOption('dots');
  await page.waitForTimeout(300);
  await shot(page, 'v2-3-pages.png');
  await page.click('#pages-close');
  if (rows !== 2 || (await countT(page, 'page.move')) !== 1 || (await countT(page, 'page.bg')) !== 1) throw new Error('ページ操作');
  log('ページ: 五線譜を追加 → 先頭へ移動 → 2ページ目をドットに変更');

  // PDF 書き出し(ベクター)
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#more-btn').then(() => page.click('#export-pdf'))]);
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
  await page.waitForSelector('.card:not(.new-card)');
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
    // 画像・テキストボックス: 表示され、投げ縄で選んで動かせる
    const items = await page.locator('g.item').count();
    log('GoodNotes取り込み: 画像・テキスト', items, '個');
    const img = page.locator('g.item image').first();
    if (await img.count()) {
      gnTitle = title;
      await img.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      const ib = await img.boundingBox();
      await page.click('#tool-lasso');
      const m = 14;
      await draw(page, [[ib.x - m, ib.y - m], [ib.x + ib.width + m, ib.y - m], [ib.x + ib.width + m, ib.y + ib.height + m], [ib.x - m, ib.y + ib.height + m], [ib.x - m, ib.y - m + 2]]);
      const label = await page.textContent('.sel-box .sel-bar span');
      if (!/画像/.test(label)) throw new Error('投げ縄で画像を選べない: ' + label);
      const tf0 = await countT(page, 'stroke.tf');
      await draw(page, [[ib.x + ib.width / 2, ib.y + ib.height / 2], [ib.x + ib.width / 2 + 40, ib.y + ib.height / 2 + 30]]);
      await page.waitForTimeout(300);
      if ((await countT(page, 'stroke.tf')) !== tf0 + 1) throw new Error('画像を動かせない');
      const ib2 = await img.boundingBox();
      if (Math.abs(ib2.x - ib.x - 40) > 3) throw new Error('画像の表示が動いていない');
      log('GoodNotes取り込み: 投げ縄で画像を選んで動かせた(' + label + ')');
      await page.click('.sel-box [data-a=off]');
      await page.click('#tool-pen');
      await shot(page, 'v2-6-goodnotes-image.png');
    }
    await page.locator('.page').nth(n - 1).scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await shot(page, 'v2-6-goodnotes-last.png');
    await page.click('#back');
  }

  // クラウド同期(WebDAV): 端末Aから送り、端末Bで受け取り、Bの変更をAへ
  const setDav = async (p) => {
    await p.click('#sync-btn');
    // 自分のサーバー(WebDAV)の欄はたたんであるので開く
    if ((await p.locator('#dav-details').getAttribute('open')) === null) await p.click('#dav-details summary');
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
  await pb.waitForSelector('.card:not(.new-card)');
  const cardsB = await pb.locator('.card:not(.new-card)').count();
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
  // 自動の同期: カーソルより後だけ読み、変わっていない端末のフォルダは中を見ない
  // (直前に手動で同期しているので、次の自動の同期は「全部見る回」ではなく ETag で判断する回になる)
  {
    const props = [];
    const onReq = (r) => { if (r.method() === 'PROPFIND') props.push(new (require('url').URL)(r.url()).pathname); };
    page.on('request', onReq);
    const autoSync = async () => {
      props.length = 0;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForTimeout(2500);
    };
    const lookedInside = () => props.some((p) => /\/ops\/.+\//.test(p));
    const status = () => page.evaluate(() => document.querySelector('#dav-form .sync-status').textContent);
    const davReq = (method, p, body) => fetch(DAV + p, { method, body, headers: { Authorization: 'Basic ' + Buffer.from('test:pass').toString('base64') } });
    const davPut = async (p, body) => { await davReq('MKCOL', p.replace(/[^/]+$/, '')); await davReq('PUT', p, body); };
    const fixed = !!process.env.FIXEDTAG;

    const before = await idb(page, 'return ops.length');
    await draw(pb, [[bb.x + 60, bb.y + 500], [bb.x + 300, bb.y + 480]]);
    await pb.waitForTimeout(6500);
    await autoSync();
    let after = await idb(page, 'return ops.length');
    if (fixed) {
      // フォルダの ETag が変わらないサーバー: 自動の同期では気づけないが、手動の同期で(2回続けて)気づき、以後は ETag を使わない
      if (after !== before || lookedInside()) throw new Error('ETag が変わらないサーバーのまねができていない');
      for (let k = 0; k < 2; k++) {
        if (k) { await draw(pb, [[bb.x + 60, bb.y + 620], [bb.x + 300, bb.y + 600]]); await pb.waitForTimeout(6500); }
        const b1 = await idb(page, 'return ops.length');
        await page.click('#sync-btn');
        await page.click('#dav-form button[type=submit]');
        await page.waitForTimeout(2500);
        await page.click('#sync-close');
        after = await idb(page, 'return ops.length');
        if (after <= b1) throw new Error('手動の同期で端末Bの新しい線が届いていない');
      }
      const b2 = after;
      await draw(pb, [[bb.x + 60, bb.y + 560], [bb.x + 300, bb.y + 540]]);
      await pb.waitForTimeout(6500);
      await autoSync();
      after = await idb(page, 'return ops.length');
      if (after <= b2) throw new Error('ETag が当てにならないと分かったあとも、自動の同期で届いていない');
      log('WebDAV: フォルダの ETag が変わらないサーバーでも、手動の同期のあとは自動で届く');
    } else {
      if (after <= before) throw new Error('自動の同期で端末Bの新しい線が届いていない');
      if (!process.env.NOETAG && !lookedInside()) throw new Error('端末Bのフォルダを見ずに届いた?: ' + props.join(' '));
      log('WebDAV: ETag が変わった端末のフォルダだけ見て、新しい線が届いた(', after - before, '件)');
      await autoSync();
      if ((await idb(page, 'return ops.length')) !== after) throw new Error('変更がないのに op が増えた');
      if (!process.env.NOETAG && lookedInside()) throw new Error('変わっていない端末のフォルダの中まで見ている: ' + props.join(' '));
      log('WebDAV: 変更がないときは', props.length, '回の問い合わせで済んだ');
    }

    // 壊れたファイル・新しい版の形のファイルがあっても、ほかの端末の変更は読める。カーソルは進めない
    const op = (d, c, n, t, p) => ({ id: `${d}:${c}`, d, c, l: 9000 + c, n, t, p, ts: Date.now() });
    await davPut('daigaku-note/ops/aaaa1/000000001-000000001.json', '{"format":"daigaku-note-ops","ver');
    await davPut('daigaku-note/ops/aaaa2/000000001-000000001.json', JSON.stringify({ format: 'daigaku-note-ops', version: 2, ops: [] }));
    await davPut('daigaku-note/ops/aaaa3/000000001-000000002.json', '{"broken');
    await davPut('daigaku-note/ops/aaaa3/000000001-000000003.json', JSON.stringify({ format: 'daigaku-note-ops', version: 1, device: 'aaaa3', ops: [op('aaaa3', 1, 'nz', 'note.create', { title: '壊れたファイルの後' })] }));
    await davPut('daigaku-note/ops/zzzz9/000000001-000000001.json', JSON.stringify({ format: 'daigaku-note-ops', version: 1, device: 'zzzz9', ops: [op('zzzz9', 1, 'nz9', 'note.create', { title: '後ろの端末' })] }));
    await page.click('#sync-btn');
    await page.click('#dav-form button[type=submit]');
    await page.waitForTimeout(2500);
    const st1 = await status();
    await page.click('#sync-close');
    const titles = await idb(page, `return ops.filter(o => o.t === 'note.create').map(o => o.p.title)`);
    if (!titles.includes('後ろの端末') || !titles.includes('壊れたファイルの後')) throw new Error('壊れたファイルの後の変更が読めていない: ' + titles.join(','));
    if (!/アプリを更新/.test(st1)) throw new Error('新しい版の形のファイルを知らせていない: ' + st1);
    const cur = await page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('daigaku-note');
      r.onsuccess = () => { const g = r.result.transaction('meta').objectStore('meta').get('davState'); g.onsuccess = () => res(g.result.cur); };
    }));
    if (cur.aaaa1 || cur.aaaa2 || cur.aaaa3 !== 3) throw new Error('カーソルの進み方がおかしい: ' + JSON.stringify(cur));
    log('WebDAV: 壊れたファイル・新しい版のファイルがあっても、ほかの変更は読めて、カーソルは進めない(', st1.replace(/^.*?。/, ''), ')');
    page.off('request', onReq);
  }
  if (gnTitle) {
    // 取り込んだ画像のファイルも同期で届き、表示される
    await pb.click('#back');
    await pb.click(`.card:has-text(${JSON.stringify(gnTitle)}) .cover`);
    await pb.waitForSelector('.page');
    const imgB = pb.locator('g.item image').first();
    await imgB.waitFor({ timeout: 10000 });
    await imgB.scrollIntoViewIfNeeded();
    log('WebDAV: 取り込んだ画像も端末Bに届いて表示された');
  }
  await pb.screenshot({ path: path.join(OUT, 'v2-7-ipad.png') });

  if (errors.length) { console.log('ERRORS:', errors); process.exitCode = 1; }
  else log('ブラウザのエラーなし');
  await browser.close();
})().catch((e) => { console.error('✗', e); process.exit(1); });
