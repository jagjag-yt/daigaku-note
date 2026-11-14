// 大学ノートアカウントの画面(ログイン・アカウント作成・アカウントの管理)。
// 通信は js/account.js、同期そのものは js/webdav.js。ここは画面だけを受け持つ。
//
// 大学ノートはログインしないと使えない。ログインしていないときは、本棚・ノートの代わりに次のページだけを出す(js/app.js の route())。
//   ログインのページ(#/login)          … メールアドレス → 6桁の番号。アカウントがなければ、同じ番号のままアカウントを作れる
//   アカウント作成のページ(#/signup)   … メールアドレス → 6桁の番号。すでにアカウントがあれば、そのままログインする
// ログインしたあと:
//   本棚の右上の人のボタン(#account-btn) … 頭文字を出す。押すとアカウントの画面
//   同期のダイアログ(#sync-dialog)      … アカウントの要約(#acct-summary)
//   アカウントの画面(#account-dialog)   … 容量・端末・ログアウト・削除
//
// ログインの状態は端末の中に持つ(同期の設定 dav.config().account)ので、オフラインでもログインしたまま使える。
// ログアウトしたとき・サーバーに鍵を断られたとき(ほかの端末から外された・退会した)に、ログインのページに戻る。
// どの場合も、端末の中のノートは消さない。
//
// 番号を送ったあとにメールのアプリへ行って戻ってきても続きから入れられるように、送った先と時刻を localStorage に覚える
// (番号そのものは覚えない。10分で番号が切れるので、それより古いものは捨てる)。
import * as account from './account.js';
import * as dav from './webdav.js';

const $ = (s) => document.querySelector(s);
const PENDING_KEY = 'daigaku-note.otp';
const LAST_KEY = 'daigaku-note.last-account'; // この端末で最後にログインしていたアカウント(別のアカウントでログインするときに確かめるため)
const CODE_MINUTES = 10; // サーバーの番号の有効期限(server/src/index.js の OTP_MINUTES)
const RESEND_SECONDS = 60; // 同じアドレスへ続けて送れない長さ(server/src/index.js の otpBurstSeconds)

// app.js から受け取る道具: { askConfirm, toast, showDialog, coarse, setSyncStatus, openSync, route, countNotes }
let h = {};
let purpose = 'login'; // 今出しているページ: 'login' | 'signup'
let pending = null; // 番号を送った先: { email, sentAt, purpose }
let resendTimer = 0;
let busy = false;
let lastTried = ''; // 断られた番号(同じ番号を自動でもう一度送らないように)
let editing = false; // 「メールアドレスを変える」を押したあと(送った番号は覚えたまま、アドレスの画面を出す)
let noAccountCode = ''; // ログインしようとしたらアカウントがなかったときの番号(このままアカウントを作るときに使う)

// ---------- 小さな道具 ----------

const now = () => Date.now();
/** ログインしているか(端末の中の設定だけで決める。通信はしない) */
export const loggedIn = () => !!dav.config().account && !dav.authExpired();
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
    .trim();
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
const initial = (email) => (String(email || '?').trim()[0] || '?').toUpperCase();

function msg(el, text) { el.textContent = text || ''; }
const emailMsg = () => $(`#auth-${purpose}-msg`);
function clearMsgs() { for (const id of ['#auth-login-msg', '#auth-signup-msg', '#acct-code-msg', '#acct-msg']) msg($(id), ''); }

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
  if (!on) updateResend(); // 送り直しは待ち時間のあいだ押せないまま
}

// ---------- 本棚のボタン・同期のダイアログの要約 ----------

/** ログインの状態が変わったら(ログイン・ログアウト・鍵が断られた)呼ぶ。ログインが切れたら、ログインのページに戻す */
export function refresh() {
  const acc = dav.config().account;
  const ok = loggedIn();
  const btn = $('#account-btn');
  const av = btn.querySelector('.acct-avatar');
  av.hidden = !ok;
  av.textContent = ok ? initial(acc.email) : '';
  btn.classList.toggle('in', ok);
  const label = ok ? `アカウント(${acc.email})` : 'アカウント';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  if (ok) $('#acct-summary-who').textContent = acc.email;

  // 本棚・ノートを出しているときにログインが切れた: ログインのページへ(書きかけの線は route() が保存する)
  if (!ok && (!$('#library').hidden || !$('#editor').hidden)) h.route?.();
}

// ---------- ログイン・アカウント作成のページ ----------

/** ログインしていないときに、本棚・ノートの代わりに出す。hash が #/signup ならアカウント作成、それ以外はログイン */
export function showAuth(hash) {
  const next = /^#\/signup\b/.test(hash) ? 'signup' : 'login';
  const was = !$('#auth').hidden;
  const changed = next !== purpose;
  purpose = next;
  if (changed) editing = false;
  $('#auth').hidden = false;
  document.title = purpose === 'signup' ? 'アカウントを作成 - 大学ノート' : 'ログイン - 大学ノート';
  render({ focus: was });
  if (!was || changed) focusInput();
  showLocalNotice();
}
/** ログインしたら隠す */
export function hideAuth() {
  $('#auth').hidden = true;
  clearTimeout(resendTimer);
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
  const parts = [];
  if (cfg.url && !cfg.account) parts.push('自分のサーバー(WebDAV)での同期は終わりました。ログインすると、大学ノートアカウントで同期します。');
  if (n > 0) parts.push(`この端末にあるノート(${n}冊)は消えません。ログインすると、アカウントに同期されます。`);
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
  updateResend();
}

// ログインしようとしたらアカウントがなかった: 番号はそのままで、アカウントを作るボタンを出す
function setNoAccount(code) {
  noAccountCode = code;
  $('#acct-noacct').hidden = !code;
  $('#acct-verify').hidden = !!code;
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
    if (run.lastError?.status === 429 && recent && recent.email === email && now() - recent.sentAt < RESEND_SECONDS * 1000) {
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
  const r = await run(el, () => account.verify(email, code, asPurpose));
  if (!r) {
    const err = run.lastError;
    if (err?.reason === 'no_account') {
      msg(el, '');
      setNoAccount(code);
      $('#acct-noacct-create').focus({ preventScroll: true });
      return;
    }
    // 「番号が違う」と断られた番号だけ覚える(通信の失敗なら、同じ番号をもう一度送れるように)
    lastTried = err?.status === 400 ? code : '';
    setNoAccount('');
    // 入れた番号は消して、打ち直してもらう(残すと、続けて打った数字や貼り付けた番号が古い番号のまま送られてしまう)
    setCode('');
    if (/あと0回/.test(el.textContent)) msg(el, '間違いが続いたため、この番号は使えません。送り直してください。');
    if (/送り直して/.test(el.textContent)) $('#acct-resend').disabled ? $('#acct-back').focus() : $('#acct-resend').focus();
    else if (!h.coarse()) $('#acct-code').focus();
    return;
  }
  await finishLogin(r, asPurpose);
}

// 鍵を受け取ったあと: 別のアカウントのノートが端末にあれば確かめてから、同期の設定を入れて本棚へ
async function finishLogin(r, asked) {
  const cfg = dav.config();
  const prev = cfg.account ? { userId: cfg.user, email: cfg.account.email } : loadLast();
  if (prev && prev.userId !== r.userId) {
    let n = 0;
    try { n = await h.countNotes(); } catch { /* 数えられないときは確かめる */ n = -1; }
    if (n !== 0) {
      const yes = await h.askConfirm({
        heading: '別のアカウントでログインしますか?',
        message: `この端末には、${prev.email} で使っていたときのノート${n > 0 ? `(${n}冊)` : ''}があります。${r.email} でログインすると、それらのノートも ${r.email} のアカウントに同期されます。`,
        ok: 'ログインする',
      });
      if (!yes) {
        // 受け取った鍵はサーバーで消しておく(失敗しても、使われない鍵は180日で消える)
        account.logout(r.token).catch(() => {});
        savePending(null);
        editing = true;
        render({ focus: true });
        $(`#auth-${purpose}-email`).value = '';
        return;
      }
    }
  }
  const ok = await run($('#acct-code-msg'), async () => {
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
  savePending(null);
  editing = false;
  for (const id of ['#auth-login-email', '#auth-signup-email']) $(id).value = '';
  const created = r.existing === false; // 以前のサーバーは existing を返さない
  h.toast(
    r.removedDevices ? 'ログインしました。ログインできる端末は5台までのため、いちばん長く使っていない端末を外しました'
      : asked === 'signup' && r.existing ? 'このメールアドレスはすでに登録されていたため、ログインしました'
        : created ? 'アカウントを作成しました。この端末のノートは自動で同期されます'
          : 'ログインしました。この端末のノートとほかの端末のノートを同期します',
    6000,
  );
  refresh();
  // ログインのページから来たなら本棚へ。ノートの住所で開いていたなら、そのノートへ
  if (/^#\/note\//.test(location.hash) || location.hash === '#/') h.route();
  else location.hash = '#/';
  dav.syncNow(true);
}

// ---------- アカウントの画面(ログイン中) ----------

/** アカウントの画面を開く */
export function open() {
  if (!loggedIn()) { h.route(); return; }
  renderInfo();
  h.showDialog($('#account-dialog'), null);
}

function renderInfo() {
  const acc = dav.config().account;
  msg($('#acct-msg'), '');
  $('#acct-avatar').textContent = initial(acc.email);
  $('#acct-who').textContent = acc.email;
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

// ログアウト・退会のあと: この端末の同期を止めて、ログインのページに戻す(端末の中のノートはそのまま)
async function accountOff() {
  const cfg = dav.config();
  if (cfg.account) saveLast({ userId: cfg.user, email: cfg.account.email });
  await dav.configure({ url: '', user: '', pass: '', auto: false });
  h.setSyncStatus('');
  refresh();
}

// ---------- つなぐ ----------

export function init(helpers) {
  h = helpers;
  pending = loadPending();

  $('#account-btn').onclick = open;
  $('#acct-open-manage').onclick = () => { $('#sync-dialog').close(); open(); };
  $('#acct-summary-sync').onclick = () => dav.syncNow(true);
  $('#account-dialog').addEventListener('cancel', (e) => { if (busy) e.preventDefault(); }); // 通信の途中は Esc で閉じない
  // 通信の途中は、ページを切り替えない(ログイン ⇔ アカウント作成)
  for (const a of document.querySelectorAll('#auth a')) a.addEventListener('click', (e) => { if (busy) e.preventDefault(); });

  for (const how of ['login', 'signup']) {
    const input = $(`#auth-${how}-email`);
    input.oninput = () => msg($(`#auth-${how}-msg`), '');
    $(`#auth-${how}-form`).onsubmit = (e) => {
      e.preventDefault();
      if (busy) return;
      const email = normalizeEmail(input.value);
      input.value = email;
      const el = $(`#auth-${how}-msg`);
      if (!email) return msg(el, 'メールアドレスを入力してください。'), input.focus();
      if (!looksLikeEmail(email)) return msg(el, 'メールアドレスの形式が正しくありません。もう一度確かめてください。'), input.focus();
      // 同じアドレス・同じ目的で送ったばかりなら、送り直さずに番号の画面へ(続けて送ると断られるため)
      const recent = loadPending();
      if (recent && recent.email === email && recent.purpose === how && now() - recent.sentAt < RESEND_SECONDS * 1000) {
        pending = recent;
        showCode({ focus: true });
        if (!h.coarse()) $('#acct-code').focus();
        return;
      }
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
  $('#acct-logout').onclick = async () => {
    const yes = await h.askConfirm({
      heading: 'ログアウトしますか?',
      message: 'ログインのページに戻ります。この端末の中のノートは消えずに残り、もう一度ログインすれば続きから使えます。',
      ok: 'ログアウト',
    });
    if (!yes) return;
    let offline = false;
    const done = await run($('#acct-msg'), async () => {
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
