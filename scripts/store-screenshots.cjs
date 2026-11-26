// ストアに載せるスクリーンショットを作る(App Store・Google Play の大きさで)。
//   別の画面で node serve.mjs 8125 を動かしてから、node scripts/store-screenshots.cjs
// 出力: store-screenshots/<端末>/<番号>-<画面>.png と、Google Play のフィーチャーグラフィック(1024×500)。
// ログインせずに使うモードで、見本のノート(講義の PDF への書き込み・方眼の手書き)を作ってから撮る。
// 線はマウスで引くので、手で字は書かない(図・下線・丸・矢印・マーカー)。文字はテキストの道具で入れる。実機で書いた画面に差し替えてもよい。
// 画面の大きさは CSS の大きさ × 倍率。どれも Chromium で撮る(画面のつくりはアプリ版と同じ)。
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BASE = process.env.URL || 'http://localhost:8125/';
const OUT = path.resolve(__dirname, '..', 'store-screenshots');
const DEVICES = [
  // Google Play: スマホ(1080×1920)・タブレット(1800×3200)。どちらも 9:16(縦)。ページ全体が画面に入る向きにする
  { name: 'play-phone', viewport: { width: 360, height: 640 }, scale: 3 },
  { name: 'play-tablet', viewport: { width: 900, height: 1600 }, scale: 2 },
  // App Store: iPhone 6.9 インチ(1320×2868)・iPad 13 インチ(2064×2752)
  { name: 'appstore-iphone-6.9', viewport: { width: 440, height: 956 }, scale: 3 },
  { name: 'appstore-ipad-13', viewport: { width: 1032, height: 1376 }, scale: 2 },
];
// タブレットでも本棚が下まで埋まる数
const FILLERS = [
  ['ミクロ経済学', 2], ['英語', 4], ['有機化学', 6], ['ゼミ', 1], ['TOEIC 単語', 5], ['統計学', 0],
  ['中国語', 3], ['日本史', 4], ['プログラミング', 6], ['心理学', 2], ['簿記', 5], ['卒論 メモ', 1],
  ['微分積分', 0], ['化学実験', 3], ['フランス語', 2], ['経営学', 6], ['生物学', 4], ['就活', 5],
  ['線形代数I', 1], ['韓国語', 3], ['法学', 6], ['サークル', 2],
];
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

const LECTURE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  body { margin: 0; font-family: "IPAPGothic", "IPAGothic", sans-serif; color: #1f2937; }
  .p { width: 210mm; height: 297mm; box-sizing: border-box; padding: 22mm 20mm; page-break-after: always; }
  .p:last-child { page-break-after: auto; }
  .h { font-size: 11pt; color: #6b7280; border-bottom: 1px solid #cbd5e1; padding-bottom: 3mm; display: flex; justify-content: space-between; }
  h1 { font-size: 22pt; margin: 9mm 0 7mm; }
  h2 { font-size: 15pt; margin: 9mm 0 3mm; color: #2f5d9e; }
  p, li { font-size: 12.5pt; line-height: 1.9; }
  .box { border: 1.5px solid #2f5d9e; border-radius: 3mm; padding: 3mm 6mm; margin: 4mm 0; background: #f3f7fd; }
  .eq { font-family: "IPAGothic", monospace; font-size: 15pt; text-align: center; margin: 5mm 0; letter-spacing: .05em; }
  table.m { margin: 3mm auto; border-left: 2px solid #1f2937; border-right: 2px solid #1f2937; font-size: 15pt; }
  table.m td { padding: 1mm 5mm; text-align: center; }
</style></head><body>
<div class="p"><div class="h"><span>線形代数学 II</span><span>第5回</span></div>
<h1>固有値と固有ベクトル</h1>
<h2>1. 定義</h2>
<div class="box"><p>n 次正方行列 A に対して、零でないベクトル x と数 λ が</p>
<p class="eq">A x = λ x</p>
<p>をみたすとき、λ を A の<b>固有値</b>、x を λ に対する<b>固有ベクトル</b>という。</p></div>
<h2>2. 固有値の求め方</h2>
<p>A x = λ x は (A − λE) x = 0 と書き直せる。x ≠ 0 の解をもつ条件は</p>
<p class="eq">det(A − λE) = 0 (固有方程式)</p>
<p>この方程式の解が固有値である。左辺を A の固有多項式という。</p>
<h2>3. 例題</h2>
<p>次の行列の固有値と固有ベクトルを求めよ。</p>
<table class="m"><tr><td>2</td><td>1</td></tr><tr><td>1</td><td>2</td></tr></table>
<p>固有方程式は (2 − λ)² − 1 = 0 より、λ = 1, 3。</p>
<ul><li>λ = 1 のとき x = t (1, −1)</li><li>λ = 3 のとき x = t (1, 1) (t ≠ 0)</li></ul>
</div>
<div class="p"><div class="h"><span>線形代数学 II</span><span>第5回</span></div>
<h2>4. 対角化</h2>
<p>A が n 個の一次独立な固有ベクトルをもつとき、それらを並べた行列 P を使って</p>
<p class="eq">P⁻¹ A P = diag(λ₁, …, λₙ)</p>
<p>と対角化できる。</p>
<h2>5. 演習</h2>
<p>(1) 次の行列を対角化せよ。</p>
<table class="m"><tr><td>4</td><td>−2</td></tr><tr><td>1</td><td>1</td></tr></table>
<p>(2) 対称行列の固有値はすべて実数であることを示せ。</p>
</div>
</body></html>`;

const FEATURE = (icon) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1024px; height: 500px; overflow: hidden; }
  body { font-family: "IPAPGothic", "IPAGothic", sans-serif; background: linear-gradient(135deg, #2f5d9e, #4b7fc6); color: #fff; display: flex; align-items: center; gap: 56px; padding: 0 80px; box-sizing: border-box; }
  img { width: 240px; height: 240px; border-radius: 52px; box-shadow: 0 16px 40px rgba(0,0,0,.25); background: #fff; }
  h1 { font-size: 72px; margin: 0 0 18px; letter-spacing: .02em; }
  p { font-size: 32px; margin: 0; line-height: 1.6; opacity: .95; }
</style></head><body><img src="data:image/png;base64,${icon}"><div><h1>かきためノート</h1><p>無料で使える手書きノート<br>スマホ・タブレット・パソコンで同期</p></div></body></html>`;

async function draw(page, pts, steps = 3) {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.waitForTimeout(120);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps });
  await page.mouse.up();
  await page.waitForTimeout(450);
}
// 手で引いたように少し揺らす
const wobble = (pts, amp = 0.6) => pts.map(([x, y], i) => [x + Math.sin(i * 1.7) * amp, y + Math.cos(i * 2.3) * amp]);
const line = (x1, y1, x2, y2, n = 8) => Array.from({ length: n + 1 }, (_, i) => [x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n]);
const ellipse = (cx, cy, rx, ry, turns = 1.08, n = 40) => Array.from({ length: n + 1 }, (_, i) => {
  const a = -Math.PI / 2 + (i / n) * Math.PI * 2 * turns;
  return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
});

async function tool(page, id) {
  const b = page.locator(`#${id}`);
  if (await b.isVisible()) await b.click();
  else {
    // 幅の狭い画面では道具がまとめて隠れていることがある
    await page.evaluate((i) => document.getElementById(i).click(), id);
  }
  await page.waitForTimeout(100);
}
async function color(page, index) {
  // 選んでいる色をもう一度押すと色のパネルが開く(次の線がパネルを閉じるだけになる)ので、選んでいれば押さない
  await page.evaluate((i) => {
    const b = document.querySelectorAll('#colors .swatch')[i];
    if (b && !b.classList.contains('on')) b.click();
  }, index);
  await page.waitForTimeout(120);
}
async function pageBox(page, i = 0) {
  return page.locator('.page').nth(i).boundingBox();
}
async function hideChrome(page) {
  await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.hidden = true; });
  await page.addStyleTag({ content: '#home-tip, .substatus { visibility: hidden !important; }' }).catch(() => {});
}

async function newNote(page, title, coverIndex, tplIndex) {
  await page.click('#new-note');
  await page.click('#new-notebook');
  await page.fill('#nn-title', title);
  const covers = page.locator('#nn-cover [role=radio]');
  if ((await covers.count()) > coverIndex) await covers.nth(coverIndex).click();
  if (tplIndex != null) {
    const tpls = page.locator('#nn-tpl [role=radio]');
    if ((await tpls.count()) > tplIndex) await tpls.nth(tplIndex).click();
  }
  await page.click('#new-form button[type=submit]');
  await page.waitForSelector('#pages svg');
  await page.waitForTimeout(300);
}
async function backToShelf(page) {
  await page.click('#back');
  await page.waitForSelector('#library:not([hidden])');
  await page.waitForTimeout(200);
}

async function shoot(page, dir, name) {
  await hideChrome(page);
  await page.mouse.move(1, 1); // ボタンの上にポインターが残って、押したように見えないように
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dir, name + '.png') });
  console.log('  ' + name);
}

// テキストの道具で、ページの (x, y) に文字を入れる
async function text(page, x, y, str) {
  await tool(page, 'tool-text');
  await page.mouse.click(x, y);
  await page.waitForTimeout(250);
  await page.keyboard.type(str, { delay: 5 });
  await page.waitForTimeout(150);
  await tool(page, 'tool-pen'); // 入れ終わる
  await page.waitForTimeout(250);
}

async function run(dev, pdfPath) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: dev.viewport, deviceScaleFactor: dev.scale, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  pageerror', e.message));
  const dir = path.join(OUT, dev.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  console.log(dev.name);
  await page.addInitScript(() => {
    let seed = 2026;
    Math.random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  });
  await page.goto(BASE);
  await page.locator('#auth .auth-skip:visible').first().click();
  await page.waitForSelector('#library:not([hidden])');
  await page.waitForTimeout(1500);

  // 本棚に並べるほかのノート。本棚は最終変更日の順なので、見本の2冊より先に作って後ろへ回す
  for (const [t, c] of FILLERS) {
    await newNote(page, t, c, 1);
    await backToShelf(page);
  }

  // 1. 講義の PDF を読み込んで書き込む
  // 日本語のファイル名のパスを渡すと、選んだことにならないことがあるので、中身と名前で渡す
  await page.setInputFiles('#pdf-input', { name: '線形代数学II 第5回.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(pdfPath) });
  await page.waitForFunction(() => location.hash.startsWith('#/note/'), null, { timeout: 60000 }).catch(async (e) => { console.log('  toast:', await page.textContent('#toast-msg')); throw e; });
  await page.waitForSelector('#pages svg');
  // 並べるために作ったノートのタブは閉じる
  while (await page.locator('#tabs .tab:not(.on) .tab-x').count()) {
    await page.locator('#tabs .tab:not(.on) .tab-x').first().click();
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(3000);
  {
    const b = await pageBox(page);
    const X = (f) => b.x + b.width * f, Y = (f) => b.y + b.height * f;
    // 位置は PDF のページに対する割合(LECTURE の1ページ目の組み方に合わせてある)
    await tool(page, 'tool-marker');
    await color(page, 0);
    await draw(page, line(X(0.43), Y(0.306), X(0.57), Y(0.306), 10)); // A x = λ x
    await draw(page, line(X(0.337), Y(0.352), X(0.398), Y(0.352), 6)); // 固有値
    await draw(page, line(X(0.551), Y(0.352), X(0.663), Y(0.352), 8)); // 固有ベクトル
    await tool(page, 'tool-pen');
    await color(page, 1);
    await draw(page, ellipse(X(0.5), Y(0.519), b.width * 0.23, b.height * 0.024)); // 固有方程式を丸で囲む
    await draw(page, wobble(line(X(0.15), Y(0.826), X(0.39), Y(0.826)))); // 例題の答えに下線
    await draw(page, [[X(0.42), Y(0.808)], [X(0.435), Y(0.822)], [X(0.465), Y(0.792)]]);
    await color(page, 2);
    await draw(page, line(X(0.80), Y(0.552), X(0.735), Y(0.532), 8)); // メモから式へ矢印
    await draw(page, [[X(0.745), Y(0.528)], [X(0.735), Y(0.532)], [X(0.742), Y(0.541)]]);
  }
  {
    const b = await pageBox(page);
    // 余白にメモ(テキスト)
    await text(page, b.x + b.width * 0.72, b.y + b.height * 0.556, 'テストに出る!');
  }
  await shoot(page, dir, '2-pdf');
  // ページ一覧
  await page.click('#pages-btn');
  await page.waitForSelector('#sidebar:not([hidden])');
  await page.waitForTimeout(1500);
  await shoot(page, dir, '4-pages');
  await page.click('#pages-btn').catch(() => {});
  await backToShelf(page);

  // 2. 方眼のノートに図を描く
  await newNote(page, '物理学 力学', 3, 7);
  {
    const b = await pageBox(page);
    const X = (f) => b.x + b.width * f, Y = (f) => b.y + b.width * f; // 縦も幅を基準に(ページは縦長)
    await text(page, X(0.10), Y(0.08), '放物運動と斜面');
    await tool(page, 'tool-pen');
    await color(page, 0);
    await draw(page, wobble(line(X(0.12), Y(0.62), X(0.12), Y(0.22))));
    await draw(page, wobble(line(X(0.12), Y(0.62), X(0.58), Y(0.62))));
    await draw(page, [[X(0.10), Y(0.25)], [X(0.12), Y(0.22)], [X(0.14), Y(0.25)]]);
    await draw(page, [[X(0.55), Y(0.60)], [X(0.58), Y(0.62)], [X(0.55), Y(0.64)]]);
    await color(page, 1);
    await draw(page, Array.from({ length: 30 }, (_, i) => { const t = i / 29; return [X(0.12 + 0.42 * t), Y(0.62 - 1.5 * 0.42 * t * (1 - t))]; }));
    await color(page, 0);
    await draw(page, wobble(line(X(0.64), Y(0.62), X(0.92), Y(0.62))));
    await draw(page, wobble(line(X(0.64), Y(0.62), X(0.92), Y(0.34))));
    await draw(page, wobble(line(X(0.92), Y(0.34), X(0.92), Y(0.62))));
    await draw(page, [[X(0.74), Y(0.47)], [X(0.80), Y(0.41)], [X(0.84), Y(0.45)], [X(0.78), Y(0.51)], [X(0.74), Y(0.47)]]);
    await color(page, 2);
    await draw(page, line(X(0.79), Y(0.46), X(0.79), Y(0.58)));
    await draw(page, [[X(0.775), Y(0.56)], [X(0.79), Y(0.58)], [X(0.805), Y(0.56)]]);
    await draw(page, Array.from({ length: 10 }, (_, i) => { const a = (-Math.PI / 4) * (i / 9); return [X(0.64) + 0.07 * b.width * Math.cos(a), Y(0.62) + 0.07 * b.width * Math.sin(a)]; })); // 角 θ
    await text(page, X(0.81), Y(0.555), 'mg');
    await text(page, X(0.72), Y(0.60), 'θ');
    await text(page, X(0.12), Y(0.70), 'x = v₀ cosθ · t');
    await text(page, X(0.12), Y(0.75), 'y = v₀ sinθ · t − ½ g t²');
    await tool(page, 'tool-marker');
    await color(page, 0);
    await draw(page, line(X(0.13), Y(0.765), X(0.41), Y(0.765), 12));
    // 付箋
    await tool(page, 'tool-sticky');
    await page.mouse.click(X(0.60), Y(0.84));
    await page.waitForTimeout(300);
    await page.keyboard.type('来週の小テスト: 斜面の問題を復習', { delay: 5 });
    await tool(page, 'tool-pen');
  }
  await shoot(page, dir, '3-handwriting');
  await backToShelf(page);

  // 3. 本棚
  await page.evaluate(() => window.scrollTo(0, 0));
  await shoot(page, dir, '1-shelf');
  await browser.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'store-shots-'));
  const pdfPath = path.join(tmp, 'lecture.pdf');
  {
    const b = await chromium.launch();
    const p = await b.newPage();
    await p.setContent(LECTURE);
    await p.pdf({ path: pdfPath, format: 'A4', printBackground: true });
    // フィーチャーグラフィック(Google Play)
    const icon = fs.readFileSync(path.resolve(__dirname, '..', 'icons', 'icon-512.png')).toString('base64');
    await p.setViewportSize({ width: 1024, height: 500 });
    await p.setContent(FEATURE(icon));
    await p.screenshot({ path: path.join(OUT, 'feature-graphic-1024x500.png') });
    await b.close();
  }
  try {
    for (const d of DEVICES) if (!ONLY || ONLY.includes(d.name)) await run(d, pdfPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
