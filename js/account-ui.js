// 大学ノートアカウントの画面(ログイン・アカウント作成・アカウントの管理)。
// 通信は js/account.js、同期そのものは js/webdav.js。ここは画面だけを受け持つ。
//
// ログインしていないときは、はじめに次のページを出す(js/app.js の route())。
// 「ログインせずに、この端末だけで使う」を選ぶと、ログインしないまま本棚・ノートを使える(同期はしない。LOCAL_KEY に覚える)。
// あとから本棚の人のボタン・同期のダイアログから、ログイン・アカウント作成のページへ行ける。
//   ログインのページ(#/login)          … メールアドレス → 6桁の番号。アカウントがなければ、同じ番号のままアカウントを作れる
//   アカウント作成のページ(#/signup)   … メールアドレス → 6桁の番号。すでにアカウントがあれば、そのままログインする
// ログインしたあと:
//   本棚の右上の人のボタン(#account-btn) … 頭文字を出す。押すとアカウントの画面
//   同期のダイアログ(#sync-dialog)      … アカウントの要約(#acct-summary)
//   アカウントの画面(#account-dialog)   … 容量・特典(クーポンコード)・端末・ログアウト・削除
//
// ログインの状態は端末の中に持つ(同期の設定 dav.config().account)ので、オフラインでもログインしたまま使える。
// ログアウトしたとき・サーバーに鍵を断られたとき(ほかの端末から外された・退会した)に、ログインのページに戻る。
// どの場合も、端末の中のノートは消さない。
//
// Apple・Google でのログイン(js/account.js の oauth…)は、ログイン・アカウント作成のどちらのページにもボタンを出す
// (サーバーで設定が済んだものだけ)。どちらから始めても、アカウントがなければ作り、あればログインする。
// 戻ってくると …#/oauth?ticket=…(ブラウザ版)・アプリの住所(アプリ版)で開かれるので、始めたページに戻して続きを行う。
//
// 番号を送ったあとにメールのアプリへ行って戻ってきても続きから入れられるように、送った先と時刻を localStorage に覚える
// (番号そのものは覚えない。10分で番号が切れるので、それより古いものは捨てる)。
import * as account from './account.js';
import * as dav from './webdav.js';
import * as db from './db.js';
import { clearExports, closeAuthPage, inAppBrowser, isNative, onAppUrl, openAuthPage, platform } from './native.js';

const $ = (s) => document.querySelector(s);
const PENDING_KEY = 'daigaku-note.otp';
const LAST_KEY = 'daigaku-note.last-account'; // この端末で最後にログインしていたアカウント(別のアカウントでログインするときに確かめるため)
const LOCAL_KEY = 'daigaku-note.local-only'; // 「ログインせずに、この端末だけで使う」を選んだ(ログインしたら消す)
const WIPED_KEY = 'daigaku-note.wiped'; // この端末のノートを消して読み込み直したあとに、続きのアドレスを入れておくため { email, how, provider }
const PROVIDERS_KEY = 'daigaku-note.oauth-providers'; // サーバーで使える Apple・Google(前に聞いた答え。ボタンをすぐ出すため)
const CODE_MINUTES = 10; // サーバーの番号の有効期限(server/src/index.js の OTP_MINUTES)
const RESEND_SECONDS = 60; // 同じアドレスへ続けて送れない長さ(server/src/index.js の otpBurstSeconds)

// app.js から受け取る道具: { askConfirm, toast, showDialog, coarse, setSyncStatus, route, countNotes, penBusy }
let h = {};
let purpose = 'login'; // 今出しているページ: 'login' | 'signup'
let pending = null; // 番号を送った先: { email, sentAt, purpose }
let resendTimer = 0;
let busy = false;
let lastTried = ''; // 断られた番号(同じ番号を自動でもう一度送らないように)
let editing = false; // 「メールアドレスを変える」を押したあと(送った番号は覚えたまま、アドレスの画面を出す)
let noAccountCode = ''; // ログインしようとしたらアカウントがなかったときの番号(このままアカウントを作るときに使う)
let providers = {}; // サーバーで使える Apple・Google { apple: true, google: false }
let providersAsked = 0; // 最後にサーバーに聞いた時刻
let oauthReturn = null; // Apple・Google から戻ってきた住所(ログインのページを出したら続きを行う)
let started = false; // 起動が済んだか(済む前に戻ってきたら、起動の流れでログインのページを出す)

// ---------- 小さな道具 ----------

const now = () => Date.now();
/** ログインしているか(端末の中の設定だけで決める。通信はしない) */
export const loggedIn = () => !!dav.config().account && !dav.authExpired();
/** ログインせずに、この端末だけで使うことを選んでいるか */
export function localOnly() {
  try { return localStorage.getItem(LOCAL_KEY) === '1'; } catch { return false; }
}
function setLocalOnly(on) {
  try { if (on) localStorage.setItem(LOCAL_KEY, '1'); else localStorage.removeItem(LOCAL_KEY); } catch { /* 覚えられなくても、今は使える */ }
}
/**
 * 本棚・ノートを出してよいか。ログインしている、またはこの端末だけで使うと決めた。
 * ただしログインが切れた(ほかの端末から外された・退会した)ときは、まずログインのページを出す
 */
/** この端末で前にログインしたことがある(ログアウトした・ログインが切れた) */
export const hadAccount = () => !!(dav.config().account || loadLast());
export const canUse = () => loggedIn() || (localOnly() && !(dav.config().account && dav.authExpired()));
const token = () => dav.config().pass;
const fresh = (v) => v && now() - v.sentAt < CODE_MINUTES * 60_000;

function loadPending() {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    if (v && typeof v.email === 'string' && fresh(v)) return { ...v, purpose: v.purpose === 'signup' ? 'signup' : 'login' };
  } catch { /* 読めないときは無いものとする */ }
  return null;
}
function savePending(v) {
  pending = v;
  try {
    if (v) localStorage.setItem(PENDING_KEY, JSON.stringify(v));
    else localStorage.removeItem(PENDING_KEY);
  } catch { /* 覚えられなくても、開いているあいだは使える */ }
}
function loadLast() {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
    if (v && typeof v.userId === 'string' && typeof v.email === 'string') return v;
  } catch { /* 読めないときは無いものとする */ }
  return null;
}
function saveLast(v) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(v)); } catch { /* 覚えられなくても困らない */ }
}

// 全角の数字・空白・ハイフンが混ざっていても、半角の数字6桁にする(日本語入力のまま打ったとき・メールから貼り付けたとき)
export function normalizeCode(v) {
  return String(v || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, '')
    .slice(0, 6);
}
// 全角の英数字・記号を半角にして、前後の空白を取る(日本語入力のまま打ったメールアドレス)
export function normalizeEmail(v) {
  return String(v || '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .trim()
    .toLowerCase(); // サーバーも小文字にそろえて保存する(前のアカウントと比べるときに、大文字だけの違いで別の人としないように)
}
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// 末尾の 0 は書かない(1 GB・1.5 GB・12.3 MB)
const trim = (x, digits) => String(Number(x.toFixed(digits)));
export function formatBytes(n) {
  if (!(n > 0)) return '0 MB';
  if (n < 1024 * 1024) return `${trim(Math.max(0.1, n / 1024 / 1024), 1)} MB`;
  if (n < 1024 ** 3) return `${trim(n / 1024 / 1024, n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${trim(n / 1024 ** 3, 2)} GB`;
}
const hhmm = (t) => new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
// アドレスを外したアカウント(持ち主を確かめずに Apple・Google から作られ、本当の持ち主が別のアカウントを作った。server/src/index.js)
const noAddress = (email) => /@unverified\.invalid$/.test(String(email || ''));
const shownEmail = (email) => (noAddress(email) ? 'Apple・Googleでログインしているアカウント' : email);
const initial = (email) => (noAddress(email) ? '?' : (String(email || '?').trim()[0] || '?').toUpperCase());

function msg(el, text) { el.textContent = text || ''; }
const emailMsg = () => $(`#auth-${purpose}-msg`);
function clearMsgs() { for (const id of ['#auth-login-msg', '#auth-signup-msg', '#acct-code-msg', '#acct-msg', '#acct-coupon-msg']) msg($(id), ''); }

// 通信のあいだは、画面のボタンを押せないようにする(2回押されないように)。失敗したら el に文言を出す
async function run(el, fn) {
  if (busy) return undefined;
  busy = true;
  run.lastError = null;
  setBusy(true);
  msg(el, '');
  try {
    return await fn();
  } catch (err) {
    console.warn(err);
    msg(el, err.status === undefined ? '問題が起きました。もう一度お試しください。' : err.message);
    run.lastError = err;
    return undefined;
  } finally {
    busy = false;
    setBusy(false);
  }
}
function setBusy(on) {
  // 閉じるボタンも止める(通信の途中で閉じると、結果のお知らせを見られないため。Esc・背景は app.js と下の cancel で止める)
  for (const b of document.querySelectorAll('#auth button, #account-dialog button, #acct-summary button')) b.disabled = on;
  $('#auth').classList.toggle('busy', on);
  $('#account-dialog').classList.toggle('busy', on);
  if (!on) {
    updateResend(); // 送り直しは待ち時間のあいだ押せないまま
    if (pending?.locked && !$('#acct-code-form').hidden) setLocked(true); // 使えなくなった番号では、ログインのボタンも押せないまま
  }
}

// ---------- 本棚のボタン・同期のダイアログの要約 ----------

/** ログインの状態が変わったら(ログイン・ログアウト・鍵が断られた)呼ぶ。ログインが切れたら、ログインのページに戻す */
export function refresh() {
  started = true; // app.js は同期の準備が済んでから呼ぶ
  if (oauthReturn && loggedIn()) { oauthReturn = null; account.takeOAuth(); } // 起動の途中に戻ってきたが、もうログインしていた
  const acc = dav.config().account;
  const ok = loggedIn();
  const btn = $('#account-btn');
  const av = btn.querySelector('.acct-avatar');
  av.hidden = !ok;
  av.textContent = ok ? initial(acc.email) : '';
  btn.classList.toggle('in', ok);
  const label = ok ? `アカウント(${shownEmail(acc.email)})` : 'アカウント';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  if (ok) $('#acct-summary-who').textContent = shownEmail(acc.email);
  $('#acct-summary-in').hidden = !ok;
  $('#acct-summary-out').hidden = ok;

  // 本棚・ノートを出しているときにログインが切れた: ログインのページへ。
  // ペンで書いている最中なら、書き終わるまで待つ(途中で画面を替えると、書いている線が消えてしまうため。待ったあとの線は route() が保存する)
  if (!ok) kickToAuth();
}
let kickTimer = 0;
function kickToAuth() {
  clearTimeout(kickTimer);
  if (canUse() || ($('#library').hidden && $('#editor').hidden)) return;
  if (h.penBusy?.()) { kickTimer = setTimeout(kickToAuth, 500); return; }
  h.route?.();
}

// ---------- ログイン・アカウント作成のページ ----------

/** ログインしていないときに、本棚・ノートの代わりに出す。hash が #/signup ならアカウント作成、それ以外はログイン */
export function showAuth(hash) {
  // 住所がログイン・アカウント作成のどちらでもない(本棚など)ときは、この端末で使ったことがあればログイン、なければアカウント作成。
  // 住所もそのページのものに置き換える(ノートの住所は、ログインしたあとに開くので残す)
  if (!/^#\/(login|signup|note\/)/.test(hash)) {
    hash = dav.config().account || loadLast() ? '#/login' : '#/signup';
    history.replaceState(null, '', hash);
  }
  const next = /^#\/signup\b/.test(hash) ? 'signup' : 'login';
  const was = !$('#auth').hidden;
  const changed = next !== purpose;
  purpose = next;
  if (changed) editing = false;
  $('#auth').hidden = false;
  document.title = purpose === 'signup' ? 'アカウントを作成 - 大学ノート' : 'ログイン - 大学ノート';
  // 初めて出したとき・ページを替えたときは見出しに移す(隠れた本棚のボタンなどに残ったままだと、読み上げで迷子になるため。
  // 見出しならスマホでもキーボードは出ない)。パソコンでは、続けてメールアドレスの欄へ
  const fresh = !was || changed;
  const back = oauthReturn;
  oauthReturn = null;
  // Apple・Google から戻った: 番号の画面ではなく、始めたページに文言を出す(送った番号は覚えたまま。取り消したときに続きから入れられるように)
  if (back) editing = true;
  render({ focus: fresh });
  if (fresh && !back) focusInput();
  showLocalNotice();
  applyProviders();
  refreshProviders();
  if (back) processOAuth(back);
}
/** ログインしたら隠す */
export function hideAuth() {
  if ($('#auth').hidden) return;
  $('#auth').hidden = true;
  clearTimeout(resendTimer);
  if ($('#auth').contains(document.activeElement)) document.activeElement.blur(); // 隠れた入力欄に残さない
}

// iPad・スマホでは、勝手にキーボードを出さない
function focusInput() {
  if (h.coarse()) return;
  const el = !$('#acct-code-form').hidden ? $('#acct-code') : $(`#auth-${purpose}-email`);
  el.focus({ preventScroll: true });
}

// 段を切り替える。focus: true なら見出しに移す(隠れた部品に残ったままだと、読み上げ・キーボードで迷子になるため)
function show(step, { focus = false } = {}) {
  for (const id of ['#auth-login-form', '#auth-signup-form', '#acct-code-form']) $(id).hidden = id !== step;
  $('#auth').scrollTop = 0;
  if (focus) $(step).querySelector('h1').focus({ preventScroll: true });
}

// 今の状態に合わせて、どの段を出すかを決める
function render({ focus = false } = {}) {
  clearMsgs();
  pending = fresh(pending) ? pending : loadPending();
  // 番号を送ったのと同じページのときだけ、番号の画面の続きを出す
  if (pending && pending.purpose === purpose && !editing) {
    showCode({ focus });
    return;
  }
  show(`#auth-${purpose}-form`, { focus });
  const acc = dav.config().account;
  const input = $(`#auth-${purpose}-email`);
  if (purpose === 'login' && acc && dav.authExpired()) {
    // ログインが切れた(ほかの端末から外された・退会した): 同じアドレスでログインし直してもらう
    if (!editing && !input.value) input.value = acc.email;
    msg(emailMsg(), 'ログインが切れました。もう一度ログインしてください。');
  }
}

// ページの下のお知らせ: この端末にあるノートは消えずに、ログインするとアカウントに同期されること
async function showLocalNotice() {
  const el = $('#auth-local');
  const cfg = dav.config();
  let n = 0;
  try { n = await h.countNotes(); } catch { /* 数えられなくても、お知らせを出さないだけ */ }
  $('#auth-offline').hidden = navigator.onLine;
  const parts = [];
  if (cfg.url && !cfg.account) parts.push('自分のサーバー(WebDAV)での同期は、この版から使えなくなりました。ログインすると、この端末で書いた内容を大学ノートアカウントで同期します。ほかの端末で書いた内容は、その端末でもログインすると同期されます。');
  if (n > 0) parts.push(`この端末にあるノート(${n}冊)は消えません。この端末で書いた内容は、ログインするとログインしたアカウントに同期されます。`);
  el.textContent = parts.join('');
  el.hidden = !parts.length;
}

function showCode({ focus = false } = {}) {
  editing = false;
  show('#acct-code-form', { focus });
  $('#acct-sent-to').textContent = pending.email;
  $('#acct-expires').textContent = hhmm(pending.sentAt + CODE_MINUTES * 60_000);
  $('#acct-verify').textContent = pending.purpose === 'signup' ? 'アカウントを作成' : 'ログイン';
  lastTried = '';
  setNoAccount('');
  setCode('');
  setLocked(!!pending.locked);
  if (pending.locked) msg($('#acct-code-msg'), '間違いが続いたため、この番号は使えません。番号を送り直してください。');
  updateResend();
}

// 間違いが続いて番号が使えなくなったら、入力欄とログインのボタンを止める(送り直すまで)
function setLocked(on) {
  $('#acct-code').disabled = on;
  $('#acct-verify').disabled = on;
  $('#acct-code-form .code-box').classList.toggle('locked', on);
}

// ログインしようとしたらアカウントがなかった: 番号はそのままで、アカウントを作るボタンを出す。
// via を渡すと、Apple・Google から(持ち主を確かめずに)作られたアカウントがあるときの案内にする(作ると、そちらからアドレスを外す)
let noAccountReplace = false;
function setNoAccount(code, via) {
  noAccountCode = code;
  noAccountReplace = via !== undefined;
  $('#acct-noacct').hidden = !code;
  $('#acct-verify').hidden = !!code;
  const name = account.PROVIDER_NAMES[via] || 'Apple・Google';
  $('#acct-noacct-text').textContent = noAccountReplace
    ? `このメールアドレスで、${name}のアカウントから作られたアカウントがあります。ご自身で作った場合は、ログインのページの「${account.PROVIDER_NAMES[via] ? `${name}で続ける` : 'Apple・Googleで続ける'}」でログインしてください。作った覚えがない場合は、このアドレスで新しいアカウントを作成できます。`
    : 'このメールアドレスのアカウントはまだありません。このままアカウントを作成できます。';
  $('#acct-noacct-create').textContent = noAccountReplace ? '新しいアカウントを作成' : 'このアドレスでアカウントを作成';
}

function setCode(v) {
  const code = normalizeCode(v);
  const input = $('#acct-code');
  if (input.value !== code) input.value = code;
  const cells = $('#acct-code-form .code-cells').children;
  for (let i = 0; i < cells.length; i++) {
    cells[i].textContent = code[i] || '';
    cells[i].classList.toggle('filled', i < code.length);
    cells[i].classList.toggle('cur', i === Math.min(code.length, cells.length - 1));
  }
  return code;
}

function updateResend() {
  clearTimeout(resendTimer);
  const b = $('#acct-resend');
  if (!pending || $('#auth').hidden) return;
  const left = Math.ceil((pending.sentAt + RESEND_SECONDS * 1000 - now()) / 1000);
  if (left > 0) {
    b.disabled = true;
    b.textContent = `番号を送り直す(${left}秒後)`;
    resendTimer = setTimeout(updateResend, 1000);
  } else {
    b.disabled = busy;
    b.textContent = '番号を送り直す';
  }
}

async function sendCode(email, el, how) {
  const sent = await run(el, async () => {
    await account.sendCode(email, how);
    savePending({ email, sentAt: now(), purpose: how });
    return true;
  });
  if (!sent) {
    // 同じアドレスへ送ったばかりで断られた(続けて送れない1分): さきほどの番号がまだ使えるので、番号の画面へ
    // (1日・IP ごとの上限で断られたときは、サーバーの文言をそのまま出す)
    const recent = loadPending();
    if (run.lastError?.status === 429 && recent && !recent.locked && recent.email === email && now() - recent.sentAt < RESEND_SECONDS * 1000) {
      pending = { ...recent, purpose: how };
      savePending(pending);
      showCode({ focus: true });
      msg($('#acct-code-msg'), 'さきほど送った番号を入力してください。');
    }
    return;
  }
  showCode({ focus: true });
  if (!h.coarse()) $('#acct-code').focus();
}

// 番号を確かめる。how を渡すと、その目的で確かめる(アカウントがなかったときに、同じ番号でアカウントを作る)
async function verify(how) {
  if (busy) return; // 確かめている途中に呼ばれたとき(7桁目・入力の確定が2回届くなど)は何もしない
  const el = $('#acct-code-msg');
  if (!pending) { // ほかのタブでログインした・番号が切れたなど
    render({ focus: true });
    return;
  }
  const code = how ? noAccountCode : setCode($('#acct-code').value);
  const asPurpose = how || pending.purpose;
  if (code.length < 6) {
    msg(el, '6桁の番号を入力してください。');
    return;
  }
  const email = pending.email;
  const r = await run(el, () => account.verify(email, code, asPurpose, !!how && noAccountReplace));
  if (!r) {
    const err = run.lastError;
    if (err?.reason === 'no_account' || err?.reason === 'unverified_owner') {
      msg(el, '');
      setNoAccount(code, err.reason === 'unverified_owner' ? err.via || '' : undefined);
      $('#acct-noacct-create').focus({ preventScroll: true });
      return;
    }
    // 「番号が違う」と断られた番号だけ覚える(通信の失敗なら、同じ番号をもう一度送れるように)
    lastTried = err?.status === 400 ? code : '';
    setNoAccount('');
    // 入れた番号は消して、打ち直してもらう(残すと、続けて打った数字や貼り付けた番号が古い番号のまま送られてしまう)
    setCode('');
    if (/あと0回|間違いが続いた/.test(el.textContent)) {
      // この番号はもう使えない: 入力を止めて、送り直してもらう(同じアドレスで送っても、この番号の画面に戻さない)
      savePending({ ...pending, locked: true });
      setLocked(true);
      msg(el, '間違いが続いたため、この番号は使えません。番号を送り直してください。');
    }
    if (/送り直して/.test(el.textContent)) $('#acct-resend').disabled ? $('#acct-back').focus() : $('#acct-resend').focus();
    else if (!h.coarse()) $('#acct-code').focus();
    return;
  }
  // アドレスは前と同じでも、別のアカウントになった(Apple・Google から作られたアカウントではなく、新しいアカウントを作った):
  // この端末のノートをどうするか、別のアカウントのときと同じく確かめる
  const discard = () => account.logout(r.token).catch(() => {});
  if (!(await confirmOtherAccount(email, asPurpose, { userId: r.userId, discard, sameEmail: true }))) {
    await discard();
    return;
  }
  await finishLogin(r, asPurpose);
}

/** ログイン・アカウント作成のページへ(この端末だけで使っているときに、本棚などから) */
export function goAuth(how) {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  location.hash = how === 'signup' ? '#/signup' : '#/login';
}

// 鍵を受け取ったあと: 同期の設定を入れて本棚へ
async function finishLogin(r, asked, el = $('#acct-code-msg')) {
  // (以前の版で自分のサーバー(WebDAV)と同期していた端末は、ログインのページを出しているあいだも WebDAV との自動同期を続けている。
  //  ここで切り替える)
  const ok = await run(el, async () => {
    // 同期先は、サーバーが返した /dav/ の住所(ログインしたサーバーと同じ場所のときだけ使う)
    const base = account.apiBase();
    const url = typeof r.dav === 'string' && r.dav.startsWith(base + '/') ? r.dav : base + '/dav/';
    // ユーザー名には利用者の ID を入れる(同期の進み具合は「URL とユーザー名」ごとに覚えるので、アカウントを替えたら最初から)
    await dav.configure({
      url, user: r.userId, pass: r.token, auto: true,
      account: { email: r.email, deviceId: r.deviceId, deviceLabel: r.deviceLabel },
    });
    return true;
  });
  if (!ok) return;
  saveLast({ userId: r.userId, email: r.email });
  setLocalOnly(false);
  savePending(null);
  editing = false;
  for (const id of ['#auth-login-email', '#auth-signup-email']) $(id).value = '';
  const created = r.existing === false; // 以前のサーバーは existing を返さない
  h.toast(
    r.removedDevices ? `ログインしました。ログインできる端末は${r.maxDevices || 5}台までのため、いちばん長く使っていない端末を外しました`
      : asked === 'signup' && r.existing ? 'このメールアドレスはすでに登録されていたため、ログインしました'
        : noAddress(r.email) ? 'ログインしました。このアカウントのメールアドレスは、アドレスの持ち主が別のアカウントを作ったため外れました。Apple・Googleでのログインはこれまでどおり使えます'
        : asked === 'oauth-new' ? '新しいアカウントを作成しました。前にメールアドレスで作ったアカウントがある場合は、ログアウトしてメールアドレスでログインしてください'
        : created ? 'アカウントを作成しました。この端末のノートは自動で同期されます'
          : 'ログインしました。この端末のノートとほかの端末のノートを同期します',
    6000,
  );
  refresh();
  // ログインのページから来たなら本棚へ(履歴に足さずに置き換える)。ノートの住所で開いていたなら、そのノートへ
  if (!/^#\/note\//.test(location.hash)) history.replaceState(null, '', '#/');
  h.route();
  dav.syncNow(true);
  refreshPerks();
}

/** サーバーの特典を端末に覚え直す(ログインしたとき・起動したとき)。失敗しても前に覚えたものを使う */
async function refreshPerks() {
  if (!loggedIn()) return;
  const user = dav.config().user;
  try {
    const me = await account.me(token());
    if (Array.isArray(me.perks) && dav.config().user === user) account.savePerks(user, me.perks, me.adFree);
  } catch { /* オフラインなど。次の機会に */ }
}

// 前の人のアドレスは伏せる(共有の端末で、ほかの人に見えないように)。先頭の1文字と @ から後ろだけ
const mask = (email) => (noAddress(email) ? 'Apple・Googleでログインしているアカウント' : email.replace(/^(.)[^@]*/, '$1***'));

// extra: 鍵を受け取ったあとに確かめるとき { provider, discard, userId, sameEmail }
//   discard はこの端末のノートを消す前に、受け取った鍵を捨てる。
//   sameEmail: true なら、アドレスが同じでも利用者が違えば確かめる(番号を確かめたあと。利用者が分かるのは鍵を受け取ってから)
async function confirmOtherAccount(email, how, extra = {}) {
  const cfg = dav.config();
  const prev = cfg.account ? { email: cfg.account.email, userId: cfg.user } : loadLast();
  if (!prev) return true;
  if (extra.sameEmail && prev.email !== email) return true; // アドレスが違うときは、番号を送る前に確かめ済み
  // 同じアカウント(同じ利用者。利用者が分からないときは、アドレスが同じ)なら確かめない
  if (extra.userId && prev.userId) {
    if (prev.userId === extra.userId) return true;
  } else if (prev.email === email) return true;
  if (prev.email === email && !extra.sameEmail && !extra.provider) return true;
  let n = -1;
  try { n = await h.countNotes(); } catch { /* 数えられないときは確かめる */ }
  if (n === 0) return true;
  const notes = `この端末には、前に別のアカウント(${mask(prev.email)})で使っていたときのノート${n > 0 ? `(${n}冊)` : ''}があります。`;
  const alt = { label: 'この端末のノートを消して続ける' };
  const ans = await h.askConfirm(how === 'signup' ? {
    heading: '新しいアカウントを作成しますか?',
    message: `${notes}そのまま続けると、この端末で書いた内容は新しいアカウントに同期されます。`,
    ok: 'そのまま続ける',
    alt,
  } : {
    heading: '別のアカウントでログインしますか?',
    message: `${notes}そのまま続けると、この端末で書いた内容はログインしたアカウントに同期されます。`,
    ok: 'そのまま続ける',
    alt,
  });
  if (ans !== 'alt') return ans;
  // この端末のノートを消す: 取り返せないので、もう一度確かめる
  const sure = await h.askConfirm({
    heading: 'この端末のノートを消しますか?',
    message: `この端末の中のノート${n > 0 ? `(${n}冊)` : ''}・PDF・画像をすべて消します。前のアカウント(${mask(prev.email)})に同期済みのものは、そのアカウントでログインすればまた使えますが、同期していない変更は元に戻せません。`,
    ok: '消す',
    danger: true,
  });
  if (!sure) return false;
  await wipeDevice(email, how, extra);
  return false; // 読み込み直すので、ここでは番号を送らない
}

// この端末のノートと設定をすべて消して、読み込み直す。読み込み直したら、入れていたアドレスで続きから
async function wipeDevice(email, how, { provider, discard } = {}) {
  busy = true;
  setBusy(true);
  try {
    await discard?.();
    await clearExports(); // アプリ版: 書き出した PDF のキャッシュも消す
    await db.wipeAll({
      onBlocked: () => msg(emailMsg(), 'ほかのタブ・ウィンドウで開いている大学ノートを閉じてください。閉じると続きます。'),
    });
    // 消せてから、前のアカウントの印を消す(消せなかったのに印だけ消すと、次は確かめずに同期してしまうため)
    try {
      localStorage.removeItem(LAST_KEY);
      localStorage.removeItem(PENDING_KEY);
      localStorage.setItem(WIPED_KEY, JSON.stringify({ email, how, provider }));
    } catch { /* 使えない環境: アドレスは入れ直してもらう */ }
    location.reload();
  } catch (err) {
    console.warn(err);
    busy = false;
    setBusy(false);
    msg(emailMsg(), 'この端末のノートを消せませんでした。ほかのタブで大学ノートを開いていたら閉じて、もう一度お試しください。');
  }
}

// 消して読み込み直したあと: アドレスを入れ直し、知らせる
function resumeAfterWipe() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(WIPED_KEY) || 'null'); localStorage.removeItem(WIPED_KEY); } catch { /* なし */ }
  if (!v || typeof v.email !== 'string') return;
  const how = v.how === 'signup' ? 'signup' : 'login';
  history.replaceState(null, '', `#/${how}`);
  const name = account.PROVIDER_NAMES[v.provider];
  if (name) {
    h.toast(`この端末のノートを消しました。もう一度「${name}で続ける」を押してください`, 6000);
    return;
  }
  $(`#auth-${how}-email`).value = v.email;
  h.toast('この端末のノートを消しました。「番号を送る」を押して続けてください', 6000);
}

// ---------- Apple・Google でのログイン ----------

function loadProviders() {
  try {
    const v = JSON.parse(localStorage.getItem(PROVIDERS_KEY) || 'null');
    if (v && typeof v === 'object') return v;
  } catch { /* なし */ }
  return {};
}

// 使える方法のボタンだけを出す(サーバーで設定が済んでいないものは出さない)
function applyProviders() {
  const names = [];
  for (const p of Object.keys(account.PROVIDER_NAMES)) if (providers[p] === true) names.push(account.PROVIDER_NAMES[p]);
  // iOS のアプリでは、Apple が使えないときは Google も出さない(App Store の決まり: ほかの会社のログインを出すなら、Apple でのログインも出す)
  const iosNoApple = isNative && platform === 'ios' && providers.apple !== true;
  const show = (p) => providers[p] === true && !(p === 'google' && (iosNoApple || inAppBrowser())); // LINE などの中では Google が断る
  for (const how of ['login', 'signup']) {
    const box = $(`#auth-${how}-social`);
    let any = false;
    for (const b of box.querySelectorAll('.oauth-btn')) {
      b.hidden = !show(b.dataset.provider);
      any ||= !b.hidden;
    }
    box.hidden = !any;
  }
  $('#auth-login-lead').textContent = names.length
    ? `${names.join('・')}のアカウント、またはメールアドレスに届く6桁の番号でログインします。パスワードは不要です。`
    : 'メールアドレスに届く6桁の番号でログインします。パスワードは不要です。';
  $('#auth-signup-how').textContent = names.length
    ? `メールアドレス、または${names.join('・')}のアカウントで作れます。パスワードは不要です`
    : 'メールアドレスだけで作れます。パスワードは不要です';
}

// サーバーに使える方法を聞く(5分に1回まで)。答えは端末に覚えて、次はすぐボタンを出す
async function refreshProviders() {
  if (now() - providersAsked < 5 * 60_000) return;
  providersAsked = now();
  try {
    const p = await account.oauthProviders();
    providers = { apple: p.apple === true, google: p.google === true };
    try { localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers)); } catch { /* 覚えられなくても、今は出せる */ }
    if (!$('#auth').hidden) applyProviders();
  } catch {
    providersAsked = 0; // オフラインなど。次にページを出したときにまた聞く
  }
}

// ボタンを押した: Apple・Google のログインの画面を開く
async function startOAuth(provider) {
  if (busy) return;
  const el = emailMsg();
  if (!navigator.onLine) { msg(el, 'オフラインのため、今はログインできません。ネットにつながってからお試しください。'); return; }
  const label = document.querySelector(`#auth-${purpose}-social .oauth-${provider} span`);
  const text = label.textContent;
  await run(el, async () => {
    await openAuthPage(await account.oauthStartUrl(provider, purpose));
    // ブラウザ版は、このままページが移る。移るまで押せないままにする(移れなかったとき・「戻る」で戻ったときは戻す)
    if (!isNative) {
      label.textContent = '移動しています…';
      await new Promise((r) => { setTimeout(r, 5000); window.addEventListener('pageshow', r, { once: true }); });
    }
  });
  label.textContent = text;
}

/**
 * Apple・Google から戻ってきた住所を受け取る(アプリの住所・ブラウザ版の #/oauth?…)。app.js の route() からも呼ぶ。
 * この端末で始めたログインの途中(合言葉を覚えている)なら受け取り、始めたページの住所にする(続きは showAuth → processOAuth)。
 * そうでなければ、住所から外すだけ(引換券が付いていたら「完了できませんでした」と出すために受け取る)。
 */
export function acceptOAuth(url) {
  if (!account.parseOAuthReturn(url)) return;
  const fromHash = /^#\/oauth\?/.test(location.hash);
  const saved = account.peekOAuth();
  if (saved && !(started && loggedIn())) {
    oauthReturn = url;
    history.replaceState(null, '', saved.purpose === 'signup' ? '#/signup' : '#/login');
    return;
  }
  if (saved) account.takeOAuth(); // ほかの方法でログインし終えていた
  if (!fromHash) return;
  // 合言葉がないのに引換券が届いた: この端末で始めたものではない(時間がたちすぎた・ホーム画面から開いたなど)。ログインしていなければ知らせる
  const known = !!saved || loggedIn() || localOnly();
  if (!known && account.parseOAuthReturn(url).ticket) oauthReturn = url;
  history.replaceState(null, '', known ? '#/' : '#/login');
}

// アプリの住所で開かれた(アプリ版で、Apple・Google から戻ってきた)
function receiveOAuth(url) {
  if (!account.peekOAuth()) return; // ログインの途中ではない(もう受け取った・取り消した・前に開かれた住所がもう一度届いた)
  closeAuthPage();
  acceptOAuth(url);
  if (!started || !oauthReturn || busy) return; // 起動の途中なら、起動の流れで route() → showAuth() が続きを行う
  const go = () => {
    if (h.penBusy?.()) { setTimeout(go, 500); return; } // ペンで書いている途中なら、書き終わるまで待つ
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    h.route();
  };
  go();
}

const OAUTH_ERRORS = {
  unavailable: (n) => `今は${n}でログインできません。メールアドレスでお試しください。`,
  rate: () => '回数が上限に達しました。しばらく待ってからお試しください。',
  expired: (n) => `時間がたちすぎたため、${n}でログインできませんでした。もう一度お試しください。`,
  no_email: (n) => `${n}のアカウントのメールアドレスを確かめられませんでした。メールアドレスでログインしてください。`,
  use_email: () => 'このメールアドレスのアカウントがすでにあります。メールアドレスに届く番号でログインしてください。',
  unverified_owner: (n, via) => {
    const v = account.PROVIDER_NAMES[via];
    const how = v && v !== n ? `ご自身で作った場合は「${v}で続ける」でログインしてください。` : 'ご自身で作った場合は、作ったときの方法でログインしてください。';
    return `このメールアドレスで、${v ? `${v}のアカウントから` : 'ほかの方法で'}作られたアカウントがあります。${how}作った覚えがない場合は、メールアドレスに届く番号でログインすると、新しいアカウントを作成できます。`;
  },
  busy: () => 'ただいまログインできません。時間をおいてお試しください。',
};

// 戻ってきた結果を受け取る: 引換券があれば、始めたときの合言葉と一緒に送って鍵を受け取る
async function processOAuth(url) {
  const r = account.parseOAuthReturn(url);
  if (!r) return;
  if (loggedIn()) return;
  const saved = account.takeOAuth();
  const el = emailMsg();
  const name = account.PROVIDER_NAMES[r.provider || saved?.provider];
  const show = (text) => { msg(el, text); el.tabIndex = -1; el.focus(); }; // 読み上げで聞き逃さないよう、文言に移る
  if (r.error) {
    if (r.error === 'cancelled') return;
    if (r.error === 'no_email' && purpose === 'signup') show(`${name}のアカウントのメールアドレスを確かめられませんでした。メールアドレスで作成してください。`);
    else show((OAUTH_ERRORS[r.error] || ((n) => `${n}でログインできませんでした。もう一度お試しください。`))(name || 'この方法', r.via));
    return;
  }
  if (!r.ticket) return;
  // 合言葉がない: この端末(このブラウザ)で始めたログインではない、または時間がたちすぎた
  if (!saved || (r.provider && saved.provider !== r.provider)) {
    const standalone = !isNative && (navigator.standalone === true || matchMedia('(display-mode: standalone)').matches);
    show(`${name ? `${name}での` : ''}ログインを完了できませんでした。もう一度お試しください。${standalone ? 'うまくいかないときは、メールアドレスでログインしてください。' : ''}`);
    return;
  }
  const res = await run(el, () => account.oauthRedeem(r.ticket, saved.verifier));
  if (!res) return;
  const discard = () => account.logout(res.token).catch(() => {}); // 受け取った鍵を使わないときは、サーバーからも外す
  if (!(await confirmOtherAccount(res.email, purpose, { provider: saved.provider, discard, userId: res.userId }))) {
    await discard();
    return;
  }
  // ログインのページから始めて、新しいアカウントができた: 前にメールアドレスで作ったアカウントとは別になることを伝える
  await finishLogin(res, purpose === 'login' && res.existing === false ? 'oauth-new' : purpose, el);
}

// ---------- アカウントの画面(ログイン中) ----------

/** アカウントの画面を開く */
export function open() {
  if (!loggedIn()) { goAuth(hadAccount() ? 'login' : 'signup'); return; }
  renderInfo();
  h.showDialog($('#account-dialog'), null);
}

function renderInfo() {
  const acc = dav.config().account;
  msg($('#acct-msg'), '');
  msg($('#acct-coupon-msg'), '');
  $('#acct-coupon-msg').classList.remove('ok');
  $('#acct-coupon').value = '';
  $('#acct-avatar').textContent = initial(acc.email);
  $('#acct-who').textContent = shownEmail(acc.email);
  $('#acct-since').textContent = acc.deviceLabel ? `この端末: ${acc.deviceLabel}` : '';
  $('#account-dialog').scrollTop = 0;
  loadDetails();
}

// 容量と端末の一覧をサーバーから読む
let loadSeq = 0;
async function loadDetails() {
  const seq = ++loadSeq;
  const ul = $('#acct-devices');
  const row = (text) => { const li = document.createElement('li'); li.className = 'none'; li.textContent = text; ul.replaceChildren(li); };
  row('読み込んでいます…');
  $('#acct-usage').textContent = '読み込んでいます…';
  const meter = $('#acct-meter');
  const [me, list] = await Promise.allSettled([account.me(token()), account.devices(token())]);
  if (seq !== loadSeq || !$('#account-dialog').open) return;
  if ([me, list].some((r) => r.status === 'rejected' && r.reason.status === 401)) {
    // 鍵が断られた(ほかの端末から外された・退会した): 同期の仕組みに知らせると、ログインのページに戻る
    dav.syncNow(true);
  }

  if (me.status === 'fulfilled' && me.value.usage) {
    const { bytes, quota } = me.value.usage;
    const pct = quota > 0 ? Math.min(100, (bytes / quota) * 100) : 0;
    meter.querySelector('span').style.width = `${bytes > 0 ? Math.max(pct, 1) : 0}%`;
    meter.setAttribute('aria-valuenow', String(Math.round(pct)));
    meter.classList.toggle('warn', pct >= 90);
    $('#acct-usage').textContent = `${formatBytes(bytes)} / ${formatBytes(quota)}(${pct < 1 && bytes > 0 ? '1% 未満' : `${Math.round(pct)}%`})`;
    meter.setAttribute('aria-valuetext', $('#acct-usage').textContent);
    if (me.value.deviceLabel) $('#acct-since').textContent = `この端末: ${me.value.deviceLabel}`;
  } else {
    meter.querySelector('span').style.width = '0%';
    meter.removeAttribute('aria-valuetext');
    $('#acct-usage').textContent = '容量を読み込めませんでした。';
  }

  if (me.status === 'fulfilled' && Array.isArray(me.value.perks)) {
    account.savePerks(dav.config().user, me.value.perks, me.value.adFree);
    renderPerks(me.value.perks);
    renderPlan(me.value.plan);
  } else {
    // 読み込めなかった(オフラインなど): 端末に覚えた特典を出す
    const cached = account.cachedPerks(dav.config().user);
    renderPerks(cached, !!cached);
  }

  if (list.status !== 'fulfilled') {
    row('端末の一覧を読み込めませんでした。');
    return;
  }
  const devices = [...list.value].sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
  ul.replaceChildren(...devices.map((d) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'acct-dev-name';
    name.textContent = d.label;
    if (d.current) {
      const tag = document.createElement('em');
      tag.className = 'acct-tag';
      tag.textContent = 'この端末';
      name.append(tag);
    }
    const when = document.createElement('small');
    when.textContent = d.current ? '使用中' : `最後に使った日: ${new Date(d.lastUsedAt).toLocaleDateString('ja-JP')}`;
    name.append(when);
    li.append(name);
    if (!d.current) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '外す';
      b.setAttribute('aria-label', `「${d.label}」を外す`);
      b.disabled = busy;
      b.onclick = async () => {
        const yes = await h.askConfirm({
          heading: 'この端末を外しますか?',
          message: `「${d.label}」はログインが切れ、もう一度ログインするまで使えなくなります。その端末の中のノートは消えません。`,
          ok: '外す',
        });
        if (yes && (await run($('#acct-msg'), async () => { await account.revoke(token(), d.id); return true; }))) loadDetails();
      };
      li.append(b);
    }
    return li;
  }));
}

// プラン(無料・Pro・Max)と、ログインできる端末の数
function renderPlan(plan) {
  const tag = $('#acct-plan');
  tag.hidden = !plan;
  if (!plan) return;
  tag.textContent = `${plan.name}プラン`;
  const n = Number(plan.devices) || 5;
  $('#acct-devices-note').textContent = `ログインできるのは${n}台までです。${n + 1}台目でログインすると、いちばん長く使っていない端末が外れます。`;
}

// 特典の一覧。null は読み込めなかったとき。old は端末に覚えた前回の情報を出しているとき
function renderPerks(perks, old = false) {
  const ul = $('#acct-perks');
  const li = (text, cls) => { const e = document.createElement('li'); if (cls) e.className = cls; e.textContent = text; return e; };
  if (!perks) { ul.replaceChildren(li('特典を読み込めませんでした。', 'none')); return; }
  const live = perks.filter((p) => !p.expiresAt || Date.parse(p.expiresAt) > Date.now());
  if (!live.length) { ul.replaceChildren(li(old ? '付いている特典はありません(前回の情報)。' : '付いている特典はありません。', 'none')); return; }
  ul.replaceChildren(...(old ? [li('サーバーに接続できないため、前回の情報を表示しています。', 'none')] : []), ...live.map((p) => {
    const e = li(p.name || p.perk);
    const when = document.createElement('small');
    when.textContent = p.expiresAt ? `${new Date(p.expiresAt).toLocaleDateString('ja-JP')} まで` : '期限なし';
    e.append(when);
    return e;
  }));
}

// ログアウト・退会のあと: この端末の同期を止めて、ログインのページに戻す(端末の中のノートはそのまま)
async function accountOff() {
  const cfg = dav.config();
  if (cfg.account) saveLast({ userId: cfg.user, email: cfg.account.email });
  account.savePerks(null);
  await dav.configure({ url: '', user: '', pass: '', auto: false });
  h.setSyncStatus('');
  refresh();
}

// ---------- つなぐ ----------

export function init(helpers) {
  h = helpers;
  pending = loadPending();
  providers = loadProviders();
  // Apple・Google から戻ってきた(ブラウザ版): 住所から引換券を外して、始めたページの住所にしておく(続きは showAuth で)
  if (/^#\/oauth\?/.test(location.hash)) acceptOAuth(location.href);
  // アプリ版: 起動のときの住所は、ログインの途中のときだけ見る(iOS は最後に開かれた住所をずっと返すため)
  onAppUrl((url) => { if (url.startsWith(account.APP_RETURN)) receiveOAuth(url); }, { launch: !!account.peekOAuth() });
  for (const b of document.querySelectorAll('#auth .oauth-btn')) b.onclick = () => startOAuth(b.dataset.provider);
  resumeAfterWipe();
  refreshPerks();

  $('#account-btn').onclick = open;
  $('#acct-summary-signup').onclick = () => goAuth('signup');
  $('#acct-summary-login').onclick = () => goAuth('login');
  // ログインせずに、この端末だけで使う(通信の途中は押せない)
  for (const b of document.querySelectorAll('#auth .auth-skip')) {
    b.onclick = async () => {
      if (busy) return;
      // ログインが切れたアカウントの同期の設定は外す(残すと、またログインのページに戻されるため。ノートは消えない)。
      // 以前の版で設定した WebDAV(自分のサーバー)の同期も外す(もう使えないと案内しているのに、裏で同期し続けないように)
      const cfg = dav.config();
      if ((cfg.account && dav.authExpired()) || (cfg.url && !cfg.account)) await accountOff();
      setLocalOnly(true);
      savePending(null);
      editing = false;
      history.replaceState(null, '', /^#\/note\//.test(location.hash) ? location.hash : '#/');
      h.route();
    };
  }
  $('#acct-open-manage').onclick = () => { $('#sync-dialog').close(); open(); };
  $('#acct-summary-sync').onclick = () => dav.syncNow(true);
  $('#account-dialog').addEventListener('cancel', (e) => { if (busy) e.preventDefault(); }); // 通信の途中は Esc で閉じない
  // 通信の途中は、ページを切り替えない(ログイン ⇔ アカウント作成)
  // ページの行き来は履歴に足さない(足すと、ログインしたあとの「戻る」が、ログインのページの住所に戻って空振りするため)
  for (const a of document.querySelectorAll('#auth a')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (!busy) location.replace(a.getAttribute('href'));
    });
  }
  // ネットにつながった・切れたら、ページの下のお知らせを合わせる
  for (const ev of ['online', 'offline']) window.addEventListener(ev, () => { if (!$('#auth').hidden) showLocalNotice(); });

  for (const how of ['login', 'signup']) {
    const input = $(`#auth-${how}-email`);
    input.oninput = () => msg($(`#auth-${how}-msg`), '');
    $(`#auth-${how}-form`).onsubmit = async (e) => {
      e.preventDefault();
      if (busy) return;
      const email = normalizeEmail(input.value);
      input.value = email;
      const el = $(`#auth-${how}-msg`);
      if (!email) return msg(el, 'メールアドレスを入力してください。'), input.focus();
      if (!looksLikeEmail(email)) return msg(el, 'メールアドレスの形式が正しくありません。もう一度確かめてください。'), input.focus();
      // 同じアドレス・同じ目的で送ったばかりなら、送り直さずに番号の画面へ(続けて送ると断られるため)
      const recent = loadPending();
      if (recent && !recent.locked && recent.email === email && recent.purpose === how && now() - recent.sentAt < RESEND_SECONDS * 1000) {
        pending = recent;
        showCode({ focus: true });
        if (!h.coarse()) $('#acct-code').focus();
        return;
      }
      // この端末に、前に別のアドレスで使っていたときのノートがあれば、そのノートも新しいアカウントに同期されることを先に確かめる
      if (!(await confirmOtherAccount(email, how))) return;
      sendCode(email, el, how);
    };
  }

  const code = $('#acct-code');
  // 入力欄は「後ろに足す・後ろから消す」だけにする(見えないカーソルが途中の桁にあると、見た目と違う桁が変わるため)
  const toEnd = () => { const n = code.value.length; try { code.setSelectionRange(n, n); } catch { /* 対応していない */ } };
  const onCode = () => {
    // 7桁以上になったら(古い番号の後ろに貼り付けた・打ち足した)、新しく入った後ろの6桁を使う
    const digits = normalizeCode(code.value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, '').slice(-6));
    const v = setCode(digits);
    toEnd();
    if (noAccountCode && v !== noAccountCode) setNoAccount(''); // 番号を打ち直したら、ふつうのログインに戻す
    if (v.length === 6 && v === lastTried) msg($('#acct-code-msg'), 'この番号は先ほど違っていました。メールの番号をもう一度確かめてください。');
    else msg($('#acct-code-msg'), '');
    // 6桁そろったら、そのまま確かめる(貼り付け・自動入力のときも)。断られたのと同じ番号は自動では送らない
    if (v.length === 6 && v !== lastTried && v !== noAccountCode) verify();
  };
  // 日本語入力で打っている途中(変換前)は書き換えない(書き換えると数字が重なる)。確定したときに読む
  code.addEventListener('input', (e) => { if (!e.isComposing) onCode(); });
  code.addEventListener('compositionend', onCode);
  // 全部を選んでいるとき(すべてを選択 → 削除)はそのままにする
  const toEndUnlessAll = () => { if (!(code.selectionStart === 0 && code.selectionEnd === code.value.length && code.value)) toEnd(); };
  for (const ev of ['click', 'keyup', 'select']) code.addEventListener(ev, toEndUnlessAll);
  // 貼り付けは、文の中の最初の6桁の数字を使う(メールの件名「大学ノートのログイン番号: 123456」をそのまま貼ったときなど)
  code.addEventListener('paste', (e) => {
    const text = (e.clipboardData?.getData('text') || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const m = /\d{6}/.exec(text.replace(/[\s-]/g, '')) || /\d{6}/.exec(text);
    if (!m) return;
    e.preventDefault();
    code.value = m[0];
    onCode();
  });
  for (const ev of ['focus', 'blur']) {
    code.addEventListener(ev, () => {
      $('#acct-code-form .code-box').classList.toggle('focus', document.activeElement === code);
      if (ev === 'focus') setTimeout(toEnd, 0);
    });
  }
  $('#acct-code-form').onsubmit = (e) => { e.preventDefault(); if (noAccountCode) verify('signup'); else verify(); };
  $('#acct-noacct-create').onclick = () => verify('signup');
  $('#acct-resend').onclick = () => { if (pending) sendCode(pending.email, $('#acct-code-msg'), pending.purpose); };
  // 送った番号は覚えたまま(同じアドレスに戻したら、送り直さずにその番号を入れられる)
  $('#acct-back').onclick = () => {
    editing = true;
    clearTimeout(resendTimer);
    if (pending) purpose = pending.purpose;
    render({ focus: true });
    const input = $(`#auth-${purpose}-email`);
    if (pending) input.value = pending.email;
    if (!h.coarse()) { input.focus(); input.select(); }
  };

  $('#acct-sync').onclick = () => dav.syncNow(true);
  const coupon = $('#acct-coupon');
  coupon.oninput = () => { msg($('#acct-coupon-msg'), ''); $('#acct-coupon-msg').classList.remove('ok'); };
  $('#acct-coupon-form').onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const el = $('#acct-coupon-msg');
    el.classList.remove('ok');
    if (!coupon.value.trim()) { msg(el, 'コードを入力してください。'); coupon.focus(); return; }
    const r = await run(el, () => account.redeemCoupon(token(), coupon.value));
    if (!r) {
      if (run.lastError?.status === 401) dav.syncNow(true); // 鍵が断られた: ログインのページに戻る
      return;
    }
    coupon.value = '';
    renderPerks(r.perks);
    loadDetails(); // プラン・容量も変わることがある(読み直して、端末にも覚え直す)
    el.classList.add('ok');
    msg(el, `「${r.name}」の特典が付きました${r.expiresAt ? `(${new Date(r.expiresAt).toLocaleDateString('ja-JP')} まで)` : ''}。`);
    h.toast(`クーポンを使いました: ${r.name}`);
  };
  $('#acct-logout').onclick = async () => {
    const yes = await h.askConfirm({
      heading: 'ログアウトしますか?',
      message: 'ログインのページに戻ります。この端末の中のノートは消えずに残り、もう一度ログインすれば続きから使えます。',
      ok: 'ログアウト',
    });
    if (!yes) return;
    let offline = false;
    const done = await run($('#acct-msg'), async () => {
      // 待っている変更を先に送る(送れなくても、変更は端末に残っていて、次にログインしたときに送る)
      try { await dav.flush(); } catch { /* 送れなくても続ける */ }
      // サーバーで鍵を消せなくても(オフラインなど)、この端末ではログアウトする
      try { await account.logout(token()); } catch (err) { offline = err.status !== 401; }
      await accountOff();
      return true;
    });
    if (done) {
      h.toast(offline
        ? 'サーバーに接続できなかったため、この端末の中だけでログアウトしました。ほかの端末の「ログイン中の端末」から外せます'
        : 'ログアウトしました。この端末のノートはそのまま残っています', 6000);
    }
  };
  $('#acct-delete').onclick = async () => {
    const yes = await h.askConfirm({
      heading: 'アカウントを削除しますか?',
      message: 'サーバーに預けた変更・PDF・画像をすべて削除し、すべての端末でログアウトします。元に戻せません。この端末の中のノートは消えずに残ります(ほかの端末の中のノートも残ります)。',
      ok: '削除する',
      danger: true,
    });
    if (!yes) return;
    const done = await run($('#acct-msg'), async () => {
      await account.deleteAccount(token());
      await accountOff();
      return true;
    });
    if (done) h.toast('アカウントを削除しました。この端末のノートはそのまま残っています', 6000);
  };
}
