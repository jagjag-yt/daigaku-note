// 大学ノートアカウントの画面のテスト(npm run test:ui)。
// 手元で動かした同期サーバー(test/worker-server.mjs。playwright.config.js が起動する)を使い、
// ログインしないと使えないこと、アカウント作成とログインのページ、2台(ブラウザの別々の保存場所)でノートが届くこと、
// 端末を外す・ログアウト・アカウントの削除までを、画面の操作で確かめる。
// 番号はメールで送らず、サーバーの応答(devCode)から読む。
import { test, expect } from '@playwright/test';

const API = 'http://127.0.0.1:8131';

// 操作の流れを確かめるテストなので、PC と スマホの大きさだけで動かす
test.beforeEach(({}, testInfo) => {
  test.skip(!['chromium-pc', 'chromium-phone', 'webkit-phone'].includes(testInfo.project.name), '流れのテストは一部の大きさだけ');
});

let seq = 0;
const freshEmail = (name, testInfo) => `${name}-${testInfo.project.name}-${process.pid}-${Date.now()}-${++seq}@example.com`;

async function open(browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript((api) => localStorage.setItem('daigaku-note.api', api), API);
  const page = await ctx.newPage();
  await page.goto('./');
  // この端末で使ったことがなければ、アカウント作成のページから
  await expect(page.locator('#auth-signup-form')).toBeVisible();
  return page;
}

// how: 'login' | 'signup'。番号を送って、番号の画面まで進む
async function sendCode(page, how, email) {
  if (how === 'signup' && !(await page.locator('#auth-signup-form').isVisible())) await page.locator('#auth-to-signup').click();
  if (how === 'login' && !(await page.locator('#auth-login-form').isVisible())) await page.locator('#auth-to-login').click();
  await page.locator(`#auth-${how}-email`).fill(email);
  const sent = page.waitForResponse((r) => r.url() === `${API}/otp/send`);
  await page.locator(`#auth-${how}-form button[type=submit]`).click();
  const res = await sent;
  expect((await res.request().postDataJSON()).purpose).toBe(how);
  const { devCode } = await res.json();
  await expect(page.locator('#acct-code-form')).toBeVisible();
  await expect(page.locator('#acct-sent-to')).toHaveText(email);
  return devCode;
}

async function signup(page, email) {
  const code = await sendCode(page, 'signup', email);
  await expect(page.locator('#acct-verify')).toHaveText('アカウントを作成');
  await page.locator('#acct-code').fill(code);
  await expect(page.locator('#library')).toBeVisible();
  await expect(page.locator('#toast-msg')).toContainText('アカウントを作成しました');
  await expect(page.locator('#account-btn .acct-avatar')).toHaveText(email[0].toUpperCase());
}

async function login(page, email) {
  const code = await sendCode(page, 'login', email);
  await expect(page.locator('#acct-verify')).toHaveText('ログイン');
  await page.locator('#acct-code').fill(code);
  await expect(page.locator('#library')).toBeVisible();
  await expect(page.locator('#toast-msg')).toContainText('ログインしました');
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

const logout = async (page) => {
  await page.locator('#account-btn').click();
  await page.locator('#acct-logout').click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#auth-login-form')).toBeVisible();
};

test('ログインしないと使えない。ログインとアカウント作成は別のページ', async ({ browser }, testInfo) => {
  const a = await open(browser);
  await expect(a).toHaveURL(/#\/signup$/);
  // 本棚・ノートの住所を開いても、ログインのページが出る
  await expect(a.locator('#library')).toBeHidden();
  await a.goto('./#/note/abc');
  await expect(a.locator('#auth-login-form')).toBeVisible();
  await expect(a.locator('#editor')).toBeHidden();
  await expect(a).toHaveTitle('ログイン - 大学ノート');
  // ページの行き来(住所も変わる)
  await a.locator('#auth-to-signup').click();
  await expect(a.locator('#auth-signup-form')).toBeVisible();
  await expect(a.locator('#auth-login-form')).toBeHidden();
  await expect(a).toHaveURL(/#\/signup$/);
  await expect(a).toHaveTitle('アカウントを作成 - 大学ノート');
  await a.locator('#auth-to-login').click();
  await expect(a.locator('#auth-login-form')).toBeVisible();
  await expect(a).toHaveURL(/#\/login$/);
  // WebDAV の設定欄はない
  await expect(a.locator('#dav-details')).toHaveCount(0);

  // ログインのページで、アカウントのないアドレス: 番号を確かめたあとで分かり、同じ番号のままアカウントを作れる
  const email = freshEmail('new', testInfo);
  const code = await sendCode(a, 'login', email);
  await a.locator('#acct-code').fill(code);
  await expect(a.locator('#acct-noacct')).toBeVisible();
  await expect(a.locator('#acct-verify')).toBeHidden();
  await expect(a.locator('#library')).toBeHidden();
  await a.locator('#acct-noacct-create').click();
  await expect(a.locator('#library')).toBeVisible();
  await expect(a.locator('#toast-msg')).toContainText('アカウントを作成しました');
  await expect(a).toHaveURL(/#\/$/);
  // 住所は置き換えるので、履歴にログインのページは増えない
  expect(await a.evaluate(() => history.length)).toBeLessThan(6);
  // ログイン済みでログインのページの住所を開くと本棚へ
  await a.goto('./#/signup');
  await expect(a.locator('#library')).toBeVisible();
  await expect(a.locator('#auth')).toBeHidden();
  // サーバーにつながらなくても(オフライン)、読み込み直したあともログインしたまま使える
  await a.route(`${API}/**`, (r) => r.abort());
  await a.reload();
  await expect(a.locator('#library')).toBeVisible();
  await expect(a.locator('#auth')).toBeHidden();
  await a.unroute(`${API}/**`);

  // アカウント作成のページで、すでにあるアドレス: そのままログインする
  await logout(a);
  const c2 = await sendCode(a, 'signup', email);
  await a.locator('#acct-code').fill(c2);
  await expect(a.locator('#library')).toBeVisible();
  await expect(a.locator('#toast-msg')).toContainText('すでに登録されていたため、ログインしました');
});

test('2台で同期し、端末を外すとログインのページに戻る。アカウントを削除してもノートは残る', async ({ browser }, testInfo) => {
  const email = freshEmail('ui', testInfo);
  const a = await open(browser);
  const b = await open(browser);

  // 1台目: アカウントを作ってノートを書く
  await signup(a, email);
  await newNote(a, '生理学');

  // 2台目: ログインすると届く
  await login(b, email);
  await expect(b.locator('#notes .card', { hasText: '生理学' })).toBeVisible();
  await b.locator('#sync-btn').click();
  await expect(b.locator('#acct-summary-who')).toHaveText(email);
  await b.locator('#sync-close').click();

  // 1台目の端末の一覧に2台目が出る。外すと(確かめの画面を通って)、2台目はログインのページに戻る
  await a.locator('#account-btn').click();
  await expect(a.locator('#acct-devices li')).toHaveCount(2);
  await a.locator('#acct-devices button', { hasText: '外す' }).click();
  await expect(a.locator('#confirm-dialog')).toBeVisible();
  await a.locator('#confirm-ok').click();
  await expect(a.locator('#acct-devices li')).toHaveCount(1);
  await b.locator('#sync-btn').click();
  await b.locator('#acct-summary-sync').click();
  await expect(b.locator('#auth-login-form')).toBeVisible();
  await expect(b.locator('#auth-login-msg')).toHaveText('ログインが切れました。もう一度ログインしてください。');
  await expect(b.locator('#auth-login-email')).toHaveValue(email);
  await expect(b.locator('#auth-local')).toContainText('この端末にあるノート(1冊)は消えません');
  // 読み込み直しても、ログインのページのまま(断られた鍵では同期しない)
  const verifies = [];
  b.on('request', (r) => { if (r.url().startsWith(`${API}/dav/`)) verifies.push(r.url()); });
  await b.reload();
  await expect(b.locator('#auth-login-form')).toBeVisible();
  await expect(b.locator('#library')).toBeHidden();
  await b.waitForTimeout(1500);
  expect(verifies).toEqual([]);
  // ログインし直すと、ノートはそのまま
  await login(b, email);
  await expect(b.locator('#notes .card', { hasText: '生理学' })).toBeVisible();

  // アカウントの削除: キャンセルできる。削除するとログインのページに戻り、ノートは端末に残る
  await a.locator('.acct-danger summary').click();
  await a.locator('#acct-delete').click();
  await expect(a.locator('#confirm-dialog')).toContainText('この端末の中のノートは消えずに残ります');
  await a.locator('#confirm-cancel').click();
  await expect(a.locator('#acct-info')).toBeVisible();
  await a.locator('#acct-delete').click();
  await a.locator('#confirm-ok').click();
  await expect(a.locator('#auth-login-form')).toBeVisible();
  await expect(a.locator('#toast-msg')).toContainText('アカウントを削除しました');
  await expect(a.locator('#auth-local')).toContainText('この端末にあるノート(1冊)は消えません');

  // 別のアカウントでログインするときは、前のアカウントのノートも同期されることを確かめる
  // (番号を送る前に確かめる。やめたら番号は送らない)
  const other = freshEmail('other', testInfo);
  await a.locator('#auth-to-signup').click();
  await a.locator('#auth-signup-email').fill(other);
  await a.locator('#auth-signup-form button[type=submit]').click();
  await expect(a.locator('#confirm-dialog')).toContainText('新しいアカウントを作成しますか?');
  await expect(a.locator('#confirm-dialog')).toContainText(`前に別のアカウント(${email[0]}***@example.com)で使っていたときのノート(1冊)`);
  await a.locator('#confirm-cancel').click();
  await expect(a.locator('#auth-signup-form')).toBeVisible();
  await expect(a.locator('#acct-code-form')).toBeHidden();
  // 続けると番号を送り、そのアカウントでログインする
  const sent = a.waitForResponse((r) => r.url() === `${API}/otp/send`);
  await a.locator('#auth-signup-form button[type=submit]').click();
  await a.locator('#confirm-ok').click();
  const { devCode } = await (await sent).json();
  await a.locator('#acct-code').fill(devCode);
  await expect(a.locator('#notes .card', { hasText: '生理学' })).toBeVisible();
  await expect(a.locator('#account-btn .acct-avatar')).toHaveText('O');
});

test('共有の端末: この端末のノートを消してから、別のアカウントで使い始められる', async ({ browser }, testInfo) => {
  const a = await open(browser);
  const first = freshEmail('first', testInfo);
  await signup(a, first);
  await newNote(a, '前の人のノート');
  await logout(a);

  const next = freshEmail('next', testInfo);
  await a.locator('#auth-to-signup').click();
  await a.locator('#auth-signup-email').fill(next);
  await a.locator('#auth-signup-form button[type=submit]').click();
  await expect(a.locator('#confirm-alt')).toHaveText('この端末のノートを消して続ける');
  await a.locator('#confirm-alt').click();
  // 取り返せないので、もう一度確かめる。やめたら何も消さない
  await expect(a.locator('#confirm-heading')).toHaveText('この端末のノートを消しますか?');
  await a.locator('#confirm-cancel').click();
  await expect(a.locator('#auth-local')).toContainText('この端末にあるノート(1冊)');
  // 消す: 読み込み直して、アドレスが入ったアカウント作成のページに戻る
  await a.locator('#auth-signup-form button[type=submit]').click();
  await a.locator('#confirm-alt').click();
  await a.locator('#confirm-ok').click();
  await expect(a.locator('#toast-msg')).toContainText('この端末のノートを消しました');
  await expect(a.locator('#auth-signup-email')).toHaveValue(next);
  await expect(a.locator('#auth-local')).toBeHidden();
  // そのまま番号を送ると、確かめの画面は出ずに番号の画面へ。新しいアカウントには前の人のノートはない
  const sent = a.waitForResponse((r) => r.url() === `${API}/otp/send`);
  await a.locator('#auth-signup-form button[type=submit]').click();
  const { devCode } = await (await sent).json();
  await expect(a.locator('#confirm-dialog')).not.toBeVisible();
  await a.locator('#acct-code').fill(devCode);
  await expect(a.locator('#library')).toBeVisible();
  await expect(a.locator('#empty')).toBeVisible();
  await expect(a.locator('#notes .card', { hasText: '前の人のノート' })).toHaveCount(0);
  // 前の人がまたログインすれば、同期済みのノートは戻る
  await logout(a);
  const c = await sendCode(a, 'login', first); // (この端末にノートがないので、確かめは出ない)
  await a.locator('#acct-code').fill(c);
  await expect(a.locator('#notes .card', { hasText: '前の人のノート' })).toBeVisible();
});

test('番号の入力の間違い・全角の入力・読み込み直したときの続き', async ({ browser }, testInfo) => {
  const a = await open(browser);
  const email = freshEmail('ui2', testInfo);
  await signup(a, email);
  await logout(a);
  await expect(a.locator('#toast-msg')).toContainText('ログアウトしました');

  // 形のおかしいアドレスは送らずに知らせる。全角で打ったアドレスは半角に直して送る
  await a.locator('#auth-login-email').fill('abc');
  await a.locator('#auth-login-form button[type=submit]').click();
  await expect(a.locator('#auth-login-msg')).toContainText('形式が正しくありません');
  const zenMail = [...email].map((c) => (c >= '!' && c <= '~' ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join('');
  await a.locator('#auth-login-email').fill(zenMail);
  const sent = a.waitForResponse((r) => r.url() === `${API}/otp/send`);
  await a.locator('#auth-login-form button[type=submit]').click();
  const { devCode } = await (await sent).json();
  await expect(a.locator('#acct-sent-to')).toHaveText(email);

  // 読み込み直しても(メールを見に行って戻ってきたとき)、番号の画面から続けられる
  await a.reload();
  await expect(a.locator('#acct-code-form')).toBeVisible();
  await expect(a.locator('#acct-resend')).toBeDisabled(); // 1分たつまでは送り直せない
  // アカウント作成のページに移ると、その番号の画面は出ない(ログインの番号なので)
  await a.goto('./#/signup');
  await expect(a.locator('#auth-signup-form')).toBeVisible();
  await a.goto('./#/login');
  await expect(a.locator('#acct-code-form')).toBeVisible();
  // 「メールアドレスを変える」で同じアドレスに戻すと、送り直さずに番号の画面へ戻る
  await a.locator('#acct-back').click();
  await expect(a.locator('#auth-login-email')).toHaveValue(email);
  await a.locator('#auth-login-form button[type=submit]').click();
  await expect(a.locator('#acct-code-form')).toBeVisible();

  // 間違った番号はサーバーの文言を出す
  const wrong = devCode === '000000' ? '111111' : '000000';
  const verify = a.waitForResponse((r) => r.url() === `${API}/otp/verify`);
  await a.locator('#acct-code').fill(wrong);
  expect((await verify).status()).toBe(400);
  await expect(a.locator('#acct-code-msg')).toContainText('番号が違います');
  await expect(a.locator('#acct-code')).toHaveValue(''); // 間違えた番号は消える(打ち足しで古い番号が送られないように)
  // 同じ間違いをもう一度打っても送らずに知らせる
  await a.locator('#acct-code').fill(wrong);
  await expect(a.locator('#acct-code-msg')).toContainText('先ほど入力して違っていた番号です');
  await a.locator('#acct-code').fill('');
  // メールの件名をそのまま貼り付けても(全角の数字でも)、番号だけを読み取る
  const zen = [...devCode].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');
  await a.locator('#acct-code').evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, `大学ノートのログイン番号: ${zen}\nこの番号は 10 分で使えなくなります。`);
  await expect(a.locator('#library')).toBeVisible();
  await a.locator('#account-btn').click();
  await expect(a.locator('#acct-who')).toHaveText(email);
});
