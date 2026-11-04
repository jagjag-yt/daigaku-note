// 画面の崩れのテスト。playwright.config.js にある全部の大きさ × Chromium/WebKit で動く。
// 各画面で「決まりごと」を確かめてから、スクショを基準の画像と比べる。
import { test, expect } from '@playwright/test';

// 日付・時刻の表示を毎回同じにする(2026-04-01 10:00 日本時間)
const NOW = new Date('2026-04-01T10:00:00+09:00');

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  // 表紙の色などのでたらめな選び方を、毎回同じ並びにする
  await page.addInitScript(() => {
    let seed = 12345;
    Math.random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  });
  await page.goto('./');
  await expect(page.locator('#new-note')).toBeVisible();
  // 一部の端末でしか出ない、端末ごとに違う ID などは隠して比べる
  await page.addStyleTag({ content: '#device-id { visibility: hidden; }' });
});

// その画面で操作できる部品(いちばん上に出ている層のものだけ)について、崩れを探す
async function layoutProblems(page) {
  return page.evaluate(() => {
    const out = [];
    const W = document.documentElement.clientWidth;
    const touch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    const se = document.scrollingElement;
    if (se.scrollWidth > W + 1) out.push(`画面が横にはみ出している(横スクロールできてしまう): 幅 ${se.scrollWidth} > ${W}`);

    const name = (el) => {
      const id = el.id ? '#' + el.id : '';
      const label = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20);
      return `${el.tagName.toLowerCase()}${id}${label ? `「${label}」` : ''}`;
    };
    const shown = (el) => {
      if (el.closest('[hidden]')) return false;
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
    const layer = dialog || pop || document.body;

    const ctrls = [...layer.querySelectorAll('button, a[href], input:not([type=hidden]):not([type=file]), select, [role=button], [role=radio]')]
      .filter(shown)
      .filter((el) => !(el.matches('input[type=radio], input[type=checkbox]') && el.closest('label'))); // 見た目はラベルのほう

    for (const el of ctrls) {
      // 検索欄のように、ラベルで囲んだ入力欄はラベル全体が押せる場所
      const box = el.matches('input') && el.closest('label') ? el.closest('label') : el;
      const r = box.getBoundingClientRect();
      // 切り取る親(overflow が visible でない)を探す。スクロールできる親の中なら、見えていなくても崩れではない
      let scrollable = false, clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        const canScroll = /(auto|scroll)/.test(cs.overflowX + cs.overflowY) && (p.scrollWidth > p.clientWidth + 1 || p.scrollHeight > p.clientHeight + 1);
        if (canScroll) { scrollable = true; break; }
        if (r.left < pr.left - 1 || r.right > pr.right + 1 || r.top < pr.top - 1 || r.bottom > pr.bottom + 1) clipped = true;
      }
      if (scrollable) continue;
      if (clipped) out.push(`${name(el)} が親の枠で切れている`);
      if (r.left < -1 || r.right > W + 1) out.push(`${name(el)} が画面の横からはみ出している (${Math.round(r.left)}〜${Math.round(r.right)} / 幅 ${W})`);

      // 真ん中を押したときに、ほかの部品に隠れていないか(重なり)
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cy >= 0 && cy <= innerHeight && cx >= 0 && cx <= W) {
        const hit = document.elementFromPoint(cx, cy);
        const label = el.closest('label');
        // 下の画面を暗くする幕(ページ一覧を重ねて出したとき)に隠れるのは、わざとなので除く
        if (hit && !el.contains(hit) && !(label && label.contains(hit)) && !hit.contains(el) && !hit.matches('.sb-scrim')) {
          out.push(`${name(el)} が ${name(hit)} に隠れている`);
        }
      }

      // 文字がボタンからあふれていないか(… で省略するものは除く)
      const cs = getComputedStyle(el);
      if (el.matches('button') && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2) {
        out.push(`${name(el)} の文字がはみ出している (${el.scrollWidth} > ${el.clientWidth})`);
      }

      // タッチの画面では、小さすぎて押しにくいボタンがないか
      if (touch && Math.min(r.width, r.height) < 28 && !el.closest('.pp-list')) {
        out.push(`${name(el)} が小さすぎて押しにくい (${Math.round(r.width)}×${Math.round(r.height)})`);
      }
    }
    return [...new Set(out)];
  });
}

async function check(page, shot) {
  await page.evaluate(() => document.fonts.ready);
  expect(await layoutProblems(page), '画面の崩れ').toEqual([]);
  await expect(page).toHaveScreenshot(`${shot}.png`, { mask: [page.locator('#saved')] });
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
