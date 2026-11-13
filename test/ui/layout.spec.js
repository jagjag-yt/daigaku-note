// 画面の崩れのテスト。playwright.config.js にある全部の大きさ × Chromium/WebKit で動く。
// 各画面で「決まりごと」を確かめてから、スクショを基準の画像と比べる。
import { test, expect } from '@playwright/test';

// 日付・時刻の表示を毎回同じにする(2026-04-01 10:00 日本時間)
const NOW = new Date('2026-04-01T10:00:00+09:00');

test.beforeEach(async ({ page }, testInfo) => {
  await page.clock.setFixedTime(NOW);
  // 表紙の色などのでたらめな選び方を、毎回同じ並びにする
  await page.addInitScript(() => {
    let seed = 12345;
    Math.random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  });
  await page.goto('./');
  await expect(page.locator('#new-note')).toBeVisible();
  // 切り欠き・ホームバーのある端末のまね: Android のアプリ版で Capacitor がするのと同じく、
  // 読み込んだあとに <html> に画面の端の幅を入れる
  const sa = testInfo.project.metadata.safeArea;
  if (sa) {
    await page.evaluate((v) => {
      for (const [k, px] of Object.entries(v)) document.documentElement.style.setProperty(`--safe-area-inset-${k}`, `${px}px`);
    }, sa);
  }
  // 一部の端末でしか出ない、端末ごとに違う ID などは隠して比べる
  await page.addStyleTag({ content: '#device-id { visibility: hidden; }' });
});

// その画面で操作できる部品(いちばん上に出ている層のものだけ)について、崩れを探す。
// 部品を見えるところまでスクロールして確かめるので、スクショを撮ったあとに呼ぶ
async function layoutProblems(page, { touch, safeArea = {} }) {
  return page.evaluate(({ touch, sa }) => {
    const out = [];
    const W = document.documentElement.clientWidth, H = innerHeight;
    const edge = { top: sa.top || 0, right: sa.right || 0, bottom: sa.bottom || 0, left: sa.left || 0 };
    const se = document.scrollingElement;
    if (se.scrollWidth > W + 1) out.push(`画面が横にはみ出している(横スクロールできてしまう): 幅 ${se.scrollWidth} > ${W}`);
    const docScrolls = se.scrollHeight > H + 1;

    const name = (el) => {
      const id = el.id ? '#' + el.id : '';
      const cls = !id && typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : '';
      const label = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20);
      return `${el.tagName.toLowerCase()}${id}${cls}${label ? `「${label}」` : ''}`;
    };
    const shown = (el) => {
      if (el.closest('[hidden]')) return false;
      // たたんだ <details> の中身(Chromium では箱の大きさが残るので、見た目どおり「見えない」とする)
      const det = el.closest('details:not([open])');
      if (det && !el.closest('summary')) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      for (let e = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
      }
      return true;
    };
    // いちばん上の層: 開いているダイアログ → 開いているポップオーバー → 画面全体
    const dialog = [...document.querySelectorAll('dialog[open]')].pop();
    const pop = document.querySelector('.pop');
    // ページ一覧を画面に重ねて出しているとき(狭い画面)は、ページ一覧がいちばん上
    const sidebar = document.querySelector('#sidebar:not([hidden])');
    const overlay = sidebar && document.querySelector('.sb-scrim:not([hidden])')?.getClientRects().length ? sidebar : null;
    const layer = dialog || pop || overlay || document.body;

    // ダイアログ・メニューそのものが画面(端の幅を除く)に収まっているか、横にスクロールしてしまわないか
    for (const box of [dialog, pop].filter(Boolean)) {
      const r = box.getBoundingClientRect();
      if (r.left < edge.left - 1 || r.right > W - edge.right + 1 || r.top < edge.top - 1 || r.bottom > H - edge.bottom + 1) {
        out.push(`${name(box)} が画面からはみ出している (${Math.round(r.left)},${Math.round(r.top)}〜${Math.round(r.right)},${Math.round(r.bottom)} / ${W}×${H})`);
      }
    }
    // 横にスクロールしてしまう箱(横に並べてスクロールするつもりの箱はないので、どれも崩れ)
    for (const el of [...(layer === document.body ? [] : [layer]), ...layer.querySelectorAll('*')]) {
      if (el.id === 'scroller' || el.closest('#scroller')) continue; // ノートのページは拡大すると横にも動かせる
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && shown(el)) {
        out.push(`${name(el)} の中身が横にはみ出してスクロールできてしまう (${el.scrollWidth} > ${el.clientWidth})`);
      }
    }

    const ctrls = [...layer.querySelectorAll('button, a[href], input:not([type=hidden]):not([type=file]), select, [role=button], [role=radio]')]
      .filter(shown)
      .filter((el) => !(el.matches('input[type=radio], input[type=checkbox]') && el.closest('label'))); // 見た目はラベルのほう

    for (const el of ctrls) {
      // 検索欄のように、ラベルで囲んだ入力欄はラベル全体が押せる場所
      const box = el.matches('input') && el.closest('label') ? el.closest('label') : el;
      let r = box.getBoundingClientRect();
      // 位置の確かめは、押せる範囲(ラベル)と入力欄そのものを合わせた範囲で
      const span = () => {
        const a = box.getBoundingClientRect(), b = el.getBoundingClientRect();
        return { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
      };
      const cs = getComputedStyle(el);

      // 大きさと文字のあふれは、スクロールしないと見えない部品でも確かめる
      if (el.matches('button') && cs.textOverflow !== 'ellipsis' && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2)) {
        out.push(`${name(el)} の文字がはみ出している (${el.scrollWidth}×${el.scrollHeight} > ${el.clientWidth}×${el.clientHeight})`);
      }
      if (touch && Math.min(r.width, r.height) < 28 && !el.closest('.pp-list')) {
        out.push(`${name(el)} が小さすぎて押しにくい (${Math.round(r.width)}×${Math.round(r.height)})`);
      }

      // スクロールできる親の中なら、見えるところまでスクロールしてから確かめる
      let scroller = null, fixed = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.position === 'fixed' || pcs.position === 'sticky' || p.matches('dialog[open], .pop')) fixed = true;
        if (!scroller && /(auto|scroll)/.test(pcs.overflowX + pcs.overflowY) && (p.scrollWidth > p.clientWidth + 1 || p.scrollHeight > p.clientHeight + 1)) scroller = p;
      }
      if (scroller) { box.scrollIntoView({ block: 'center', inline: 'nearest' }); r = box.getBoundingClientRect(); }
      const o = span();
      // 切り取る親(overflow が visible でない)で切れていないか
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.overflowX === 'visible' && pcs.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        if (o.left < pr.left - 1 || o.right > pr.right + 1 || o.top < pr.top - 1 || o.bottom > pr.bottom + 1) {
          out.push(`${name(el)} が ${name(p)} の枠で切れている`);
          break;
        }
      }
      // 画面の外・画面の端(切り欠き・ホームバー)にかかっていないか。
      // 縦は、ページ全体がスクロールする本棚の中身では確かめない(スクロールすれば見える)
      if (o.left < edge.left - 1 || o.right > W - edge.right + 1) {
        out.push(`${name(el)} が画面の横の端にかかっている (${Math.round(o.left)}〜${Math.round(o.right)} / 幅 ${W}、端 ${edge.left}・${edge.right})`);
      }
      if ((scroller || fixed || !docScrolls) && (o.top < edge.top - 1 || o.bottom > H - edge.bottom + 1)) {
        out.push(`${name(el)} が画面の上下の端にかかっている (${Math.round(o.top)}〜${Math.round(o.bottom)} / 高さ ${H}、端 ${edge.top}・${edge.bottom})`);
      }

      // 隠れていないか(重なり)。真ん中と四隅の近くを押してみる
      const label = el.closest('label');
      const mine = (hit) => !hit || el.contains(hit) || (label && label.contains(hit)) || hit.contains(el)
        || hit.matches('.sb-scrim'); // 下の画面を暗くする幕(ページ一覧を重ねて出したとき)に隠れるのはわざと
      const ix = Math.min(6, r.width / 4), iy = Math.min(6, r.height / 4);
      for (const [x, y] of [[r.left + r.width / 2, r.top + r.height / 2], [r.left + ix, r.top + iy], [r.right - ix, r.top + iy], [r.left + ix, r.bottom - iy], [r.right - ix, r.bottom - iy]]) {
        if (x < 0 || x > W || y < 0 || y > H) continue;
        const hit = document.elementFromPoint(x, y);
        if (!mine(hit)) { out.push(`${name(el)} が ${name(hit)} に隠れている`); break; }
      }
    }
    return [...new Set(out)];
  }, { touch, sa: safeArea });
}

async function check(page, shot) {
  const info = test.info();
  // 入力欄にカーソルがあると、端末によって見た目が変わるので外す
  await page.evaluate(() => { if (document.activeElement?.matches('input, select, textarea')) document.activeElement.blur(); });
  await page.evaluate(() => document.fonts.ready);
  // 先にスクショ(決まりごとの確認は部品をスクロールさせるため)。違っていても決まりごとまで確かめる
  await expect.soft(page).toHaveScreenshot(`${shot}.png`, { mask: [page.locator('#saved')] });
  const problems = await layoutProblems(page, { touch: !!info.project.use.hasTouch, safeArea: info.project.metadata.safeArea });
  expect(problems, '画面の崩れ').toEqual([]);
}

async function newNote(page, title) {
  await page.locator('#new-note').click();
  await page.locator('#new-notebook').click();
  await expect(page.locator('#new-dialog')).toBeVisible();
  await page.locator('#nn-title').fill(title);
  await page.locator('#new-form button[type=submit]').click();
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#pages svg').first()).toBeVisible();
}

test('本棚(ノートなし)', async ({ page }) => {
  await check(page, 'library-empty');
});

test('新規メニュー', async ({ page }) => {
  await page.locator('#new-note').click();
  await expect(page.locator('#new-notebook')).toBeVisible();
  await check(page, 'new-menu');
});

test('新しいノートのダイアログ', async ({ page }) => {
  await page.locator('#new-note').click();
  await page.locator('#new-notebook').click();
  await expect(page.locator('#new-dialog')).toBeVisible();
  await page.locator('#nn-title').blur();
  await check(page, 'new-dialog');
});

test('同期のダイアログ', async ({ page }) => {
  await page.locator('#sync-btn').click();
  await expect(page.locator('#sync-dialog')).toBeVisible();
  await page.evaluate(() => document.activeElement?.blur());
  await check(page, 'sync-dialog');
});

test('同期のダイアログ(自分のサーバーの欄を開く)', async ({ page }) => {
  await page.locator('#sync-btn').click();
  await expect(page.locator('#sync-dialog')).toBeVisible();
  await page.locator('#dav-details summary').click();
  await expect(page.locator('#dav-url')).toBeVisible();
  await page.evaluate(() => document.activeElement?.blur());
  await check(page, 'sync-dialog-webdav');
});

test('本棚(ノートあり・長い名前)', async ({ page }) => {
  await newNote(page, '生理学');
  await page.locator('#back').click();
  await newNote(page, 'とても長い名前のノートで本棚の表示が崩れないか確かめるためのノート');
  await page.locator('#back').click();
  await expect(page.locator('#notes .card:not(.new-card)')).toHaveCount(2);
  await check(page, 'library-notes');
});

test('ノートの画面', async ({ page }) => {
  await newNote(page, 'とても長い名前のノートで道具の並びが崩れないか確かめる');
  await check(page, 'editor');
});

test('ノートの画面(ページ一覧)', async ({ page }) => {
  await newNote(page, '生理学');
  await page.locator('#pages-btn').click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('#pp-list img, #pp-list canvas, #pp-list svg').first()).toBeVisible();
  await check(page, 'editor-sidebar');
});

test('ノートの画面(その他のメニュー)', async ({ page }) => {
  await newNote(page, '生理学');
  await page.locator('#more-btn').click();
  await expect(page.locator('.pop')).toBeVisible();
  await check(page, 'editor-more');
});

test('ページの追加のダイアログ', async ({ page }) => {
  await newNote(page, '生理学');
  await page.locator('#pages-btn').click();
  await page.locator('#sb-add').click();
  await expect(page.locator('#add-dialog')).toBeVisible();
  await page.evaluate(() => document.activeElement?.blur());
  await check(page, 'add-page-dialog');
});
