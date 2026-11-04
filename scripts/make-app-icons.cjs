// Android・iOS のアイコン・起動画面を icons/icon.svg から作る(アイコンを変えたときに一度だけ動かす)
//   node scripts/make-app-icons.cjs .
// playwright(Chromium)と python3 の Pillow を使う
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const { execFileSync } = require('child_process');
const root = process.argv[2];
const res = path.join(root, 'android/app/src/main/res');
const svg = fs.readFileSync(path.join(root, 'icons/icon.svg'), 'utf8');
const inner = svg.replace(/^[\s\S]*?<rect width="512" height="512" rx="96" fill="#2f5d9e"\/>/, '').replace(/<\/svg>\s*$/, '');
// 適応型アイコンの前景: 背景の四角を除き、周りに余白をとる(108dp のうち 72dp に収める)
const fg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-128 -128 768 768">${inner.replace('y="0" width="22" height="512"', 'y="-128" width="22" height="768"')}</svg>`;
const legacy = svg;
const round = svg.replace('rx="96"', 'rx="256"');
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  async function render(src, w, h, file, bg = 'transparent', scale = 1) {
    await p.setViewportSize({ width: w, height: h });
    const s = Math.min(w, h) * scale;
    await p.setContent(`<html><body style="margin:0;background:${bg};width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center">${src.replace('<svg ', `<svg width="${s}" height="${s}" `)}</body></html>`);
    await p.screenshot({ path: file, omitBackground: bg === 'transparent' });
  }
  for (const [d, k] of Object.entries(dens)) {
    const dir = path.join(res, 'mipmap-' + d);
    await render(legacy, 48 * k, 48 * k, path.join(dir, 'ic_launcher.png'));
    await render(round, 48 * k, 48 * k, path.join(dir, 'ic_launcher_round.png'));
    await render(fg, 108 * k, 108 * k, path.join(dir, 'ic_launcher_foreground.png'));
  }
  for (const dir of fs.readdirSync(res).filter((d) => d.startsWith('drawable'))) {
    const f = path.join(res, dir, 'splash.png');
    if (!fs.existsSync(f)) continue;
    const [w, h] = execFileSync('python3', ['-c', `from PIL import Image; im=Image.open('${f}'); print(*im.size)`]).toString().trim().split(' ').map(Number);
    await render(legacy, w, h, f, '#f6f7f9', 0.3);
  }
  // iOS: 角は OS が丸めるので四角のまま・透明なし。起動画面は 2732×2732 の真ん中にアイコン
  const ios = path.join(root, 'ios/App/App/Assets.xcassets');
  await render(svg.replace('rx="96"', 'rx="0"'), 1024, 1024, path.join(ios, 'AppIcon.appiconset/AppIcon-512@2x.png'), '#2f5d9e');
  for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    await render(legacy, 2732, 2732, path.join(ios, 'Splash.imageset', f), '#f6f7f9', 0.18);
  }
  await b.close();
})();
