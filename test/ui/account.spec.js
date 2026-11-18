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

test('ログインしていないと、最初はログイン・アカウント作成のページ。2つは別のページ', async ({ browser }, testInfo) => {
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
  await expect(a.locator('#acct-code-msg')).toContainText('先ほど違っていました');
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

test('クーポンコード: アカウントの画面で使うと特典が付く。2回目は使えない', async ({ browser, request }, testInfo) => {
  const a = await open(browser);
  await signup(a, freshEmail('coupon', testInfo));
  const { code } = await (await request.post(`${API}/__test/coupon`, { data: { perk: 'adfree' } })).json();

  await a.locator('#account-btn').click();
  await expect(a.locator('#acct-perks')).toContainText('付いている特典はありません');
  // 空のまま押すと知らせる
  await a.locator('#acct-coupon-use').click();
  await expect(a.locator('#acct-coupon-msg')).toContainText('コードを入力してください');
  // 小文字・ハイフンなしでも通る
  await a.locator('#acct-coupon').fill(code.toLowerCase().replace(/-/g, ''));
  await a.locator('#acct-coupon-use').click();
  await expect(a.locator('#acct-coupon-msg')).toContainText('「広告なし」の特典が付きました');
  await expect(a.locator('#acct-perks')).toContainText('広告なし');
  await expect(a.locator('#acct-perks')).toContainText('期限なし');
  await expect(a.locator('#acct-coupon')).toHaveValue('');
  expect(await a.evaluate(() => JSON.parse(localStorage.getItem('daigaku-note.perks')).perks[0].perk)).toBe('adfree');

  await a.locator('#acct-coupon').fill(code);
  await a.locator('#acct-coupon-use').click();
  await expect(a.locator('#acct-coupon-msg')).toContainText('すでに使っています');
  await a.locator('#acct-coupon').fill('ABCD');
  await expect(a.locator('#acct-coupon-msg')).toBeEmpty();
  await a.locator('#acct-coupon-use').click();
  await expect(a.locator('#acct-coupon-msg')).toContainText('形が正しくありません');

  // 開き直しても特典が出る(サーバーから読む)
  await a.keyboard.press('Escape');
  await a.locator('#account-btn').click();
  await expect(a.locator('#acct-perks')).toContainText('広告なし');
});

test('ログインせずに、この端末だけで使える。あとからアカウントを作ると、そのノートが同期される', async ({ browser }, testInfo) => {
  const a = await open(browser);
  await a.locator('#auth-signup-form .auth-skip').click();
  await expect(a.locator('#library')).toBeVisible();
  await expect(a).toHaveURL(/#\/$/);
  await newNote(a, 'ローカルのノート');
  // 読み込み直しても、ログインのページは出ない
  await a.reload();
  await expect(a.locator('#library')).toBeVisible();
  await expect(a.locator('#auth')).toBeHidden();
  // 同期のダイアログは、ログインをすすめる
  await a.locator('#sync-btn').click();
  await expect(a.locator('#acct-summary-out')).toBeVisible();
  await expect(a.locator('#acct-summary-in')).toBeHidden();
  // 人のボタンからアカウント作成のページへ行き、ログインせずに戻れる
  await a.keyboard.press('Escape');
  await a.locator('#account-btn').click();
  await expect(a.locator('#auth-signup-form')).toBeVisible();
  await a.locator('#auth-signup-form .auth-skip').click();
  await expect(a.locator('#notes .card', { hasText: 'ローカルのノート' })).toBeVisible();
  // アカウントを作ると、この端末のノートがアカウントに同期され、ほかの端末に届く
  const email = freshEmail('local', testInfo);
  await a.locator('#sync-btn').click();
  await a.locator('#acct-summary-signup').click();
  await expect(a.locator('#auth-signup-form')).toBeVisible();
  await signup(a, email);
  await expect(a.locator('#notes .card', { hasText: 'ローカルのノート' })).toBeVisible();
  await expect(a.locator('.sync-status').first()).toContainText(/同期しました/, { timeout: 15_000 });
  const b = await open(browser);
  await login(b, email);
  await expect(b.locator('#notes .card', { hasText: 'ローカルのノート' })).toBeVisible({ timeout: 15_000 });
  // ログアウトすると、ログインのページに戻る(この端末だけで使うこともできる)
  await logout(a);
  await a.locator('#auth-login-form .auth-skip').click();
  await expect(a.locator('#notes .card', { hasText: 'ローカルのノート' })).toBeVisible();
});

test('プラン: Pro のクーポンを使うと、アカウントの画面のプラン・容量・端末の数が変わる', async ({ browser, request }, testInfo) => {
  const a = await open(browser);
  await signup(a, freshEmail('plan', testInfo));
  await a.locator('#account-btn').click();
  await expect(a.locator('#acct-plan')).toHaveText('無料プラン');
  await expect(a.locator('#acct-usage')).toContainText('/ 1 GB');
  const { code } = await (await request.post(`${API}/__test/coupon`, { data: { perk: 'pro', days: 30 } })).json();
  await a.locator('#acct-coupon').fill(code);
  await a.locator('#acct-coupon-use').click();
  await expect(a.locator('#acct-coupon-msg')).toContainText('「Pro プラン」の特典が付きました');
  await expect(a.locator('#acct-plan')).toHaveText('Proプラン');
  await expect(a.locator('#acct-usage')).toContainText('/ 30 GB');
  await expect(a.locator('#acct-devices-note')).toContainText('10台まで');
  expect(await a.evaluate(() => JSON.parse(localStorage.getItem('daigaku-note.perks')).adFree)).toBe(true);
});

// ---- Apple・Google でのログイン ----
// Apple・Google のログインの画面は差し替える: 同期サーバーの /oauth/<p>/start の答え(Apple・Google へのリダイレクト)を受け取り、
// その画面を飛ばして、すぐに同期サーバーの戻り口へ戻す(リダイレクトの先は page.route で差し替えられないため)。
// code には { sub, email, nonce } を入れる(test/worker-server.mjs がそれを ID トークンにして答える)
async function fakeIdp(ctx, who, { cancel = false } = {}) {
  await ctx.route(`${API}/oauth/*/start?**`, async (r) => {
    const res = await r.fetch({ maxRedirects: 0 });
    const loc = new URL(res.headers().location);
    if (!/^https:\/\/(accounts\.google\.com|appleid\.apple\.com)$/.test(loc.origin)) return r.fulfill({ response: res });
    const q = loc.searchParams;
    const code = Buffer.from(JSON.stringify({ ...who, nonce: q.get('nonce') })).toString('base64url');
    if (loc.origin === 'https://accounts.google.com') {
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('state', q.get('state'));
      if (cancel) back.searchParams.set('error', 'access_denied');
      else back.searchParams.set('code', code);
      return r.fulfill({ status: 302, headers: { location: back.href } });
    }
    // Apple はフォームの POST で戻す
    const fields = cancel ? `<input name="error" value="user_cancelled_authorize">` : `<input name="code" value="${code}">`;
    return r.fulfill({
      contentType: 'text/html',
      body: `<form method="post" action="${q.get('redirect_uri')}"><input name="state" value="${q.get('state')}">${fields}</form><script>document.forms[0].submit()</script>`,
    });
  });
}

test('Google・Apple で続けると、アカウントができて本棚へ。2回目は同じアカウント', async ({ browser }, testInfo) => {
  // Gmail のアドレス(Google が持ち主を管理しているので、メールの番号のアカウントとつながる)
  const email = freshEmail('g', testInfo).replace('@example.com', '@gmail.com');
  const a = await open(browser);
  await fakeIdp(a.context(), { sub: `g-${email}`, email });
  // サーバーで設定が済んでいるので、ボタンが出る。アカウント作成の説明も合わせる
  await expect(a.locator('#auth-signup-social .oauth-google')).toBeVisible();
  await expect(a.locator('#auth-signup-social .oauth-apple')).toBeVisible();
  await expect(a.locator('#auth-signup-how')).toHaveText('メールアドレス、またはApple・Googleのアカウントで作れます。パスワードは不要です');
  await a.locator('#auth-signup-social .oauth-google').click();
  await expect(a.locator('#library')).toBeVisible();
  await expect(a.locator('#toast-msg')).toContainText('アカウントを作成しました');
  await expect(a.locator('#account-btn .acct-avatar')).toHaveText(email[0].toUpperCase());
  // 引換券は住所に残さない
  await expect(a).toHaveURL(/#\/$/);
  expect(a.url()).not.toContain('ticket');
  await newNote(a, '解剖学');

  // ログアウトして、ログインのページから同じ Google のアカウントで: 同じアカウント
  await logout(a);
  await a.locator('#auth-login-social .oauth-google').click();
  await expect(a.locator('#library')).toBeVisible();
  await expect(a.locator('#toast-msg')).toContainText('ログインしました');
  await expect(a.locator('#notes .card', { hasText: '解剖学' })).toBeVisible();

  // 別の端末で、メールの番号でログインしても同じアカウント(Google が確かめたアドレスでつながる)
  const b = await open(browser);
  await login(b, email);
  await expect(b.locator('#notes .card', { hasText: '解剖学' })).toBeVisible();

  // Apple(フォームの POST で戻る)に同じ Gmail のアドレスを付けていても、Apple は Gmail の持ち主を管理していないので、
  // 前からのアカウントにはつながず、メールの番号でログインするよう案内する
  const c = await open(browser);
  await fakeIdp(c.context(), { sub: `a-${email}`, email });
  await c.locator('#auth-signup-social .oauth-apple').click();
  await expect(c.locator('#auth-signup-msg')).toHaveText('このメールアドレスのアカウントがすでにあります。メールアドレスに届く番号でログインしてください。');
  await expect(c.locator('#auth-signup-msg')).toBeFocused();
  await expect(c.locator('#library')).toBeHidden();
  // Apple の「メールを非公開」なら、別の新しいアカウント
  await fakeIdp(c.context(), { sub: `a2-${email}`, email: `x${seq}@privaterelay.appleid.com`, is_private_email: true });
  await c.locator('#auth-signup-social .oauth-apple').click();
  await expect(c.locator('#library')).toBeVisible();
  await expect(c.locator('#toast-msg')).toContainText('アカウントを作成しました');
  for (const p of [a, b, c]) await p.context().close();
});

test('Google のログインを取り消したら、ログインのページのまま。始めていない引換券は使えない', async ({ browser }, testInfo) => {
  const a = await open(browser);
  await fakeIdp(a.context(), {}, { cancel: true });
  await a.locator('#auth-to-login').click();
  await a.locator('#auth-login-social .oauth-google').click();
  await expect(a.locator('#auth-login-form')).toBeVisible();
  await expect(a).toHaveURL(/#\/login$/);
  await expect(a.locator('#auth-login-msg')).toBeHidden(); // 取り消しは失敗ではないので、何も出さない

  // 他人が自分の引換券を踏ませても(ログイン CSRF)、この端末で始めていないので使われない
  const email = freshEmail('csrf', testInfo);
  const other = await open(browser);
  await fakeIdp(other.context(), { sub: `g-${email}`, email });
  // 相手の端末で始めて、戻ってくる住所(引換券つき)を横取りする
  await other.route('http://localhost:8130/**', (r) => r.fulfill({ body: 'stop' }));
  await other.locator('#auth-signup-social .oauth-google').click();
  await expect.poll(() => other.url()).toContain('ticket=');
  const stolen = other.url();
  await a.goto(stolen.replace(/^http:\/\/localhost:8130\//, './'));
  await expect(a.locator('#auth-login-msg')).toHaveText('Googleでのログインを完了できませんでした。もう一度お試しください。');
  await expect(a.locator('#library')).toBeHidden();
  expect(a.url()).not.toContain('ticket');
  await a.context().close();
  await other.context().close();
});
