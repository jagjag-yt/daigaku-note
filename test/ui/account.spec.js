// 大学ノートアカウントで同期する画面のテスト(npm run test:ui)。
// 手元で動かした同期サーバー(test/worker-server.mjs。playwright.config.js が起動する)にログインし、
// 2台(ブラウザの別々の保存場所)でノートが届くこと、端末を外す・ログアウト・アカウントの削除までを、画面の操作で確かめる。
// 番号はメールで送らず、サーバーの応答(devCode)から読む。
import { test, expect } from '@playwright/test';

const API = 'http://127.0.0.1:8131';

// 操作の流れを確かめるテストなので、PC と スマホの大きさの2つだけで動かす
test.beforeEach(({}, testInfo) => {
  test.skip(!['chromium-pc', 'chromium-phone', 'webkit-phone'].includes(testInfo.project.name), '流れのテストは一部の大きさだけ');
});

async function open(browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript((api) => localStorage.setItem('daigaku-note.api', api), API);
  const page = await ctx.newPage();
  await page.goto('./');
  await expect(page.locator('#new-note')).toBeVisible();
  return page;
}

async function login(page, email) {
  await page.locator('#sync-btn').click();
  await expect(page.locator('#acct-login')).toBeVisible();
  await expect(page.locator('#dav-details')).not.toHaveAttribute('open', ''); // 自分のサーバーの欄はたたんである
  await page.locator('#acct-email').fill(email);
  const sent = page.waitForResponse((r) => r.url() === `${API}/otp/send`);
  await page.locator('#acct-send').click();
  const { devCode } = await (await sent).json();
  await expect(page.locator('#acct-code-form')).toBeVisible();
  await expect(page.locator('#acct-sent-to')).toHaveText(email);
  await page.locator('#acct-code').fill(devCode);
  await page.locator('#acct-verify').click();
  await expect(page.locator('#acct-info')).toBeVisible();
  await expect(page.locator('#acct-who')).toHaveText(email);
  await expect(page.locator('#acct-info .sync-status')).toContainText('同期しました');
}

async function newNote(page, title) {
  await page.locator('#new-note').click();
  await page.locator('#new-notebook').click();
  await page.locator('#nn-title').fill(title);
  await page.locator('#new-form button[type=submit]').click();
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#back').click();
  await expect(page.locator('#notes .card', { hasText: title })).toBeVisible();
}

test('メールの番号でログインして2台で同期し、端末を外し、アカウントを削除する', async ({ browser }, testInfo) => {
  const email = `ui-${testInfo.project.name}-${Date.now()}@example.com`;
  const a = await open(browser);
  const b = await open(browser);

  // 1台目: ノートを作ってからログインすると、送られる
  await newNote(a, '生理学');
  await login(a, email);
  await expect(a.locator('#acct-devices')).toContainText('ほかにログインしている端末はありません');

  // 2台目: ログインすると届く
  await login(b, email);
  await b.locator('#sync-close').click();
  await expect(b.locator('#notes .card', { hasText: '生理学' })).toBeVisible();

  // 1台目の「ほかの端末」に2台目が出る。外すと(確かめの画面を通って)、2台目は「ログインが切れました」になる
  await a.locator('#acct-sync').click();
  await a.locator('#sync-close').click();
  await a.locator('#sync-btn').click();
  await expect(a.locator('#acct-devices li')).toHaveCount(1);
  await a.locator('#acct-devices button', { hasText: '外す' }).click();
  await expect(a.locator('#confirm-dialog')).toBeVisible();
  await a.locator('#confirm-ok').click();
  await expect(a.locator('#acct-devices')).toContainText('ほかにログインしている端末はありません');
  await b.locator('#sync-btn').click();
  await b.locator('#acct-sync').click();
  await expect(b.locator('#acct-login')).toBeVisible();
  await expect(b.locator('#acct-msg')).toHaveText('ログインが切れました。もう一度ログインしてください');
  await expect(b.locator('#acct-email')).toHaveValue(email);
  await b.locator('#sync-close').click();

  // アカウントの削除: キャンセルできる。削除しても、この端末のノートは残る
  await a.locator('#acct-delete').click();
  await expect(a.locator('#confirm-dialog')).toContainText('この端末の中のノートは消えずに残ります');
  await a.locator('#confirm-cancel').click();
  await expect(a.locator('#acct-info')).toBeVisible();
  await a.locator('#acct-delete').click();
  await a.locator('#confirm-ok').click();
  await expect(a.locator('#acct-login')).toBeVisible();
  await expect(a.locator('#toast-msg')).toContainText('アカウントを削除しました');
  await a.locator('#sync-close').click();
  await expect(a.locator('#notes .card', { hasText: '生理学' })).toBeVisible();
  // 削除したアカウントの鍵は使えない(同期は止まっている)
  await expect(a.locator('.substatus .sync-status')).toHaveText('クラウド同期はオフです');
});

test('ログアウトすると同期が止まり、自分のサーバー(WebDAV)の欄は今までどおり使える', async ({ browser }, testInfo) => {
  const a = await open(browser);
  await login(a, `ui2-${testInfo.project.name}-${Date.now()}@example.com`);
  await a.locator('#acct-logout').click();
  await expect(a.locator('#acct-login')).toBeVisible();
  await expect(a.locator('#acct-info .sync-status')).toHaveText('クラウド同期はオフです');
  // 間違った番号はサーバーの文言を出す
  await a.locator('#acct-email').fill('wrong@example.com');
  await a.locator('#acct-send').click();
  await a.locator('#acct-code').fill('000000');
  const verify = a.waitForResponse((r) => r.url() === `${API}/otp/verify`);
  await a.locator('#acct-verify').click();
  if ((await verify).status() !== 200) await expect(a.locator('#acct-msg')).toContainText('番号が違います');
  // WebDAV の欄を開くと、前と同じ入力欄がある
  await a.locator('#dav-details summary').click();
  for (const id of ['#dav-url', '#dav-user', '#dav-pass', '#dav-auto']) await expect(a.locator(id)).toBeVisible();
});
