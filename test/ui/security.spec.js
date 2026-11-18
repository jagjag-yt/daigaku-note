// 他人が書き出したノート(同期ファイル)に仕込まれた値で、スクリプトが動かないこと(npm run test:ui)。
// 以前は表紙の色に細工すると、本棚を出したときにスクリプトが動いた。
import { test, expect } from '@playwright/test';

const API = 'http://127.0.0.1:8131';

test.beforeEach(({}, testInfo) => {
  test.skip(!['chromium-pc', 'webkit-phone'].includes(testInfo.project.name), '一部の大きさだけ');
});

test('細工したノートを取り込んでも、スクリプトは動かず、ふつうの部分は取り込める', async ({ browser }, testInfo) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript((api) => localStorage.setItem('daigaku-note.api', api), API);
  const page = await ctx.newPage();
  const violations = [];
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  await page.goto('./');
  // ログインする
  await page.locator('#auth-signup-email').fill(`sec-${testInfo.project.name}-${Date.now()}@example.com`);
  const sent = page.waitForResponse((r) => r.url() === `${API}/otp/send`);
  await page.locator('#auth-signup-form button[type=submit]').click();
  const { devCode } = await (await sent).json();
  await page.locator('#acct-code').fill(devCode);
  await expect(page.locator('#library')).toBeVisible();

  const evil = 'red"><img id="pwned" src="x" onerror="document.title=\'XSS\'">';
  const op = (c, n, t, p) => ({ id: `zzzz9999:${c}`, d: 'zzzz9999', c, l: 1000 + c, ts: Date.now(), n, t, p });
  const file = {
    format: 'daigaku-note-sync', version: 1, device: 'zzzz9999', exportedAt: new Date().toISOString(),
    ops: [
      op(1, 'evil1', 'note.create', { title: '表紙に細工', cover: evil }),
      op(2, 'x"><img src=x onerror="document.title=1">', 'note.create', { title: 'ID に細工' }),
      op(3, 'good1', 'note.create', { title: 'ふつうのノート', cover: '#16a34a' }),
    ],
    files: [{ hash: 'a'.repeat(64), name: 'x.pdf', type: 'text/html', data: 'https://example.com/evil' }],
  };
  await page.locator('#sync-input').setInputFiles({ name: 'evil.daigaku.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await expect(page.locator('#toast-msg')).toContainText('取り込みました');
  await expect(page.locator('#notes')).toContainText('ふつうのノート');
  await expect(page.locator('#notes')).toContainText('表紙に細工'); // 色だけを外して残す
  await expect(page.locator('#notes')).not.toContainText('ID に細工');
  await expect(page.locator('#pwned')).toHaveCount(0);
  expect(await page.title()).toBe('大学ノート');
  expect(violations).toEqual([]);
});

test('iPhone の Safari では「ホーム画面に追加」の案内を出し、閉じたら次から出さない', async ({ browser }) => {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  await ctx.addInitScript(() => localStorage.setItem('daigaku-note.local-only', '1'));
  const page = await ctx.newPage();
  await page.goto('./');
  await expect(page.locator('#library')).toBeVisible();
  await expect(page.locator('#home-tip')).toBeVisible();
  await page.locator('.home-tip-close').click();
  await expect(page.locator('#home-tip')).toBeHidden();
  await page.reload();
  await expect(page.locator('#library')).toBeVisible();
  await expect(page.locator('#home-tip')).toBeHidden();
  await ctx.close();
});

test('パソコンのブラウザでは「ホーム画面に追加」の案内を出さない', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => localStorage.setItem('daigaku-note.local-only', '1'));
  const page = await ctx.newPage();
  await page.goto('./');
  await expect(page.locator('#library')).toBeVisible();
  await expect(page.locator('#home-tip')).toBeHidden();
  await ctx.close();
});
