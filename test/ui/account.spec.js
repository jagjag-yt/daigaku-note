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
  await page.locator('#account-btn').click();
  await expect(page.locator('#acct-email-form')).toBeVisible();
  await page.locator('#acct-email').fill(email);
  const sent = page.waitForResponse((r) => r.url() === `${API}/otp/send`);
  await page.locator('#acct-send').click();
  const { devCode } = await (await sent).json();
  await expect(page.locator('#acct-code-form')).toBeVisible();
  await expect(page.locator('#acct-sent-to')).toHaveText(email);
  await expect(page.locator('#acct-resend')).toBeDisabled(); // 続けて送れない1分のあいだは押せない
  // 6桁そろうと、ボタンを押さなくてもログインする
  await page.locator('#acct-code').fill(devCode);
  await expect(page.locator('#acct-info')).toBeVisible();
  await expect(page.locator('#acct-who')).toHaveText(email);
  await expect(page.locator('#acct-note')).toContainText('ログインしました');
  await expect(page.locator('#acct-info .sync-status')).toContainText('同期しました');
  await expect(page.locator('#acct-devices')).toContainText('この端末');
  await expect(page.locator('#acct-usage')).toContainText('/ 1.00 GB');
  await expect(page.locator('#account-btn .acct-avatar')).toHaveText(email[0].toUpperCase());
}

const closeAccount = (page) => page.locator('#account-dialog .dlg-close').click();

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
  await expect(a.locator('#acct-devices li')).toHaveCount(1); // この端末だけ

  // 2台目: 同期のダイアログの要約からログインの画面を開く。ログインすると届く
  await b.locator('#sync-btn').click();
  await expect(b.locator('#acct-summary-out')).toBeVisible();
  await expect(b.locator('#dav-details')).not.toHaveAttribute('open', ''); // 自分のサーバーの欄はたたんである
  await b.locator('#acct-open-login').click();
  await expect(b.locator('#sync-dialog')).not.toBeVisible();
  await closeAccount(b);
  await login(b, email);
  await closeAccount(b);
  await expect(b.locator('#notes .card', { hasText: '生理学' })).toBeVisible();
  await b.locator('#sync-btn').click();
  await expect(b.locator('#acct-summary-who')).toHaveText(email);
  await b.locator('#sync-close').click();

  // 1台目の端末の一覧に2台目が出る。外すと(確かめの画面を通って)、2台目は「ログインが切れました」になる
  await closeAccount(a);
  await a.locator('#account-btn').click();
  await expect(a.locator('#acct-devices li')).toHaveCount(2);
  await a.locator('#acct-devices button', { hasText: '外す' }).click();
  await expect(a.locator('#confirm-dialog')).toBeVisible();
  await a.locator('#confirm-ok').click();
  await expect(a.locator('#acct-devices li')).toHaveCount(1);
  // 2台目でアカウントの画面を開くと、サーバーに断られたことが分かり、ログインの画面に戻る
  await b.locator('#account-btn').click();
  await expect(b.locator('#acct-email-form')).toBeVisible();
  await expect(b.locator('#acct-email-msg')).toHaveText('ログインが切れました。もう一度ログインしてください');
  await expect(b.locator('#acct-email')).toHaveValue(email);
  await expect(b.locator('#account-btn .acct-dot')).toBeVisible();
  await closeAccount(b);

  // アカウントの削除: キャンセルできる。削除しても、この端末のノートは残る
  await a.locator('.acct-danger summary').click();
  await a.locator('#acct-delete').click();
  await expect(a.locator('#confirm-dialog')).toContainText('この端末の中のノートは消えずに残ります');
  await a.locator('#confirm-cancel').click();
  await expect(a.locator('#acct-info')).toBeVisible();
  await a.locator('#acct-delete').click();
  await a.locator('#confirm-ok').click();
  await expect(a.locator('#account-dialog')).not.toBeVisible();
  await expect(a.locator('#toast-msg')).toContainText('アカウントを削除しました');
  await expect(a.locator('#notes .card', { hasText: '生理学' })).toBeVisible();
  await expect(a.locator('#account-btn .acct-avatar')).toBeHidden();
  // 削除したアカウントの鍵は使えない(同期は止まっている)
  await expect(a.locator('.substatus .sync-status')).toHaveText('クラウド同期はオフです');
});

test('ログアウトすると同期が止まる。番号の入力の間違い・全角の入力・閉じて戻ったときの続き', async ({ browser }, testInfo) => {
  const a = await open(browser);
  await login(a, `ui2-${testInfo.project.name}-${Date.now()}@example.com`);
  await a.locator('#acct-logout').click();
  await a.locator('#confirm-ok').click();
  await expect(a.locator('#acct-email-form')).toBeVisible();
  await expect(a.locator('#toast-msg')).toContainText('ログアウトしました');
  await expect(a.locator('.substatus .sync-status')).toHaveText('クラウド同期はオフです');

  // 形のおかしいアドレスは送らずに知らせる。全角で打ったアドレスは半角に直して送る
  await a.locator('#acct-email').fill('abc');
  await a.locator('#acct-send').click();
  await expect(a.locator('#acct-email-msg')).toContainText('形式が正しくありません');
  await a.locator('#acct-email').fill('ｗｒｏｎｇ＠ｅｘａｍｐｌｅ．ｃｏｍ');
  const sent = a.waitForResponse((r) => r.url() === `${API}/otp/send`);
  await a.locator('#acct-send').click();
  const { devCode } = await (await sent).json();
  await expect(a.locator('#acct-sent-to')).toHaveText('wrong@example.com');

  // 閉じて開き直しても(メールを見に行って戻ってきたとき)、番号の画面から続けられる
  await closeAccount(a);
  await a.locator('#account-btn').click();
  await expect(a.locator('#acct-code-form')).toBeVisible();

  // 間違った番号はサーバーの文言を出す
  const wrong = devCode === '000000' ? '111111' : '000000';
  const verify = a.waitForResponse((r) => r.url() === `${API}/otp/verify`);
  await a.locator('#acct-code').fill(wrong);
  expect((await verify).status()).toBe(400);
  await expect(a.locator('#acct-code-msg')).toContainText('番号が違います');
  // 全角の数字でも入る
  await a.locator('#acct-code').fill([...devCode].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join(''));
  await expect(a.locator('#acct-info')).toBeVisible();
  await expect(a.locator('#acct-who')).toHaveText('wrong@example.com');

  // 「同期の設定」から、自分のサーバー(WebDAV)の欄を今までどおり使える
  await a.locator('#acct-logout').click();
  await a.locator('#confirm-ok').click();
  await a.locator('#acct-to-sync').click();
  await expect(a.locator('#sync-dialog')).toBeVisible();
  for (const id of ['#dav-url', '#dav-user', '#dav-pass', '#dav-auto']) await expect(a.locator(id)).toBeVisible();
});
