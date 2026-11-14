// 大学ノートアカウントの画面(ログイン・新規登録・アカウントの管理)。
// 通信は js/account.js、同期そのものは js/webdav.js。ここは画面だけを受け持つ。
//
//   本棚の右上の人のボタン(#account-btn) … ログイン中は頭文字を出す。ログインが切れたら赤い点
//   同期のダイアログ(#sync-dialog)      … アカウントの要約(#acct-summary)。ここからこの画面を開く
//   アカウントの画面(#account-dialog)   … メールアドレス → 6桁の番号 → ログイン中(容量・端末・ログアウト・削除)
//
// 番号を送ったあとにメールのアプリへ行って戻ってきても続きから入れられるように、送った先と時刻を localStorage に覚える
// (番号そのものは覚えない。10分で番号が切れるので、それより古いものは捨てる)。
import * as account from './account.js';
import * as dav from './webdav.js';

const $ = (s) => document.querySelector(s);
const PENDING_KEY = 'daigaku-note.otp';
const CODE_MINUTES = 10; // サーバーの番号の有効期限(server/src/index.js の OTP_MINUTES)
const RESEND_SECONDS = 60; // 同じアドレスへ続けて送れない長さ(server/src/index.js の otpBurstSeconds)

let h = {}; // app.js から受け取る道具: { askConfirm, toast, showDialog, coarse, openSync }
let pending = null; // 番号を送った先: { email, sentAt }
let resendTimer = 0;
let busy = false;
let note = ''; // ログイン直後などに管理の画面の上に出すお知らせ
let lastTried = ''; // 断られた番号(同じ番号を自動でもう一度送らないように)
let editing = false; // 「メールアドレスを変える」を押したあと(送った番号は覚えたまま、アドレスの画面を出す)

// ---------- 小さな道具 ----------

const now = () => Date.now();
const loggedIn = () => !!dav.config().account && !dav.authExpired();
const token = () => dav.config().pass;

function loadPending() {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    if (v && typeof v.email === 'string' && now() - v.sentAt < CODE_MINUTES * 60_000) return v;
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
function clearMsgs() { for (const id of ['#acct-email-msg', '#acct-code-msg', '#acct-msg']) msg($(id), ''); }

// 通信のあいだは、画面のボタンを押せないようにする(2回押されないように)。失敗したら el に文言を出す
async function run(el, fn) {
  if (busy) return;
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
  for (const b of document.querySelectorAll('#account-dialog button, #acct-summary button')) b.disabled = on;
  $('#account-dialog').classList.toggle('busy', on);
  if (!on) updateResend(); // 送り直しは待ち時間のあいだ押せないまま
}

// ---------- 本棚のボタン・同期のダイアログの要約 ----------

/** ログインの状態が変わったら(ログイン・ログアウト・鍵が断られた)呼ぶ。開いている画面も合わせる */
export function refresh() {
  const acc = dav.config().account;
  const ok = loggedIn();
  const btn = $('#account-btn');
  const av = btn.querySelector('.acct-avatar');
  av.hidden = !ok;
  av.textContent = ok ? initial(acc.email) : '';
  btn.classList.toggle('in', ok);
  btn.querySelector('.acct-dot').hidden = !(acc && dav.authExpired());
  const label = ok ? `アカウント(${acc.email})` : acc ? 'アカウント(ログインが切れました)' : 'アカウント(ログイン・新規登録)';
  btn.title = label;
  btn.setAttribute('aria-label', label);

  $('#acct-summary-out').hidden = ok;
  $('#acct-summary-in').hidden = !ok;
  if (ok) $('#acct-summary-who').textContent = acc.email;
  const expired = !!acc && !ok;
  $('#acct-summary-text').textContent = expired
    ? `${acc.email} のログインが切れたため、同期が止まっています。もう一度ログインすると再開します。`
    : 'ログインするだけで、ほかの端末と自動で同期します。サーバーの用意や設定はいりません(無料・1人 1GB まで)。';
  $('#acct-open-login').textContent = expired ? 'もう一度ログイン' : 'ログイン・新規登録';

  // 管理の画面を開いているときに鍵が断られたら、ログインの画面に戻す(逆も)
  const d = $('#account-dialog');
  if (d.open && ok === $('#acct-info').hidden) render();
}

// ---------- アカウントの画面 ----------

// 段を切り替える。ダイアログの名前(読み上げ)もその段の見出しにする。
// focus: true なら見出しに移す(隠れた部品に残ったままだと、読み上げ・キーボードで迷子になるため)
function show(step, { focus = false } = {}) {
  for (const id of ['#acct-email-form', '#acct-code-form', '#acct-info']) $(id).hidden = id !== step;
  const d = $('#account-dialog');
  const head = $(step).querySelector('h2');
  d.setAttribute('aria-labelledby', head.id);
  d.scrollTop = 0;
  if (focus && d.open) head.focus({ preventScroll: true });
}

// 今の状態に合わせて、どの段を出すかを決める
function render({ focus = false } = {}) {
  clearMsgs();
  const acc = dav.config().account;
  if (loggedIn()) {
    renderInfo({ focus });
    return;
  }
  pending = pending && now() - pending.sentAt < CODE_MINUTES * 60_000 ? pending : loadPending();
  if (pending && !editing) {
    showCode({ focus });
    return;
  }
  show('#acct-email-form', { focus });
  $('#acct-local-logout').hidden = !acc;
  if (acc) {
    // ログインが切れた: 同じアドレスでログインし直してもらう
    if (!editing) $('#acct-email').value = acc.email;
    msg($('#acct-email-msg'), 'ログインが切れました。もう一度ログインしてください。');
  }
}

/** アカウントの画面を開く */
export function open() {
  editing = false;
  render();
  const focus = !$('#acct-email-form').hidden ? $('#acct-email') : !$('#acct-code-form').hidden ? $('#acct-code') : null;
  h.showDialog($('#account-dialog'), focus);
}

function showCode({ focus = false } = {}) {
  editing = false;
  show('#acct-code-form', { focus });
  $('#acct-sent-to').textContent = pending.email;
  $('#acct-expires').textContent = hhmm(pending.sentAt + CODE_MINUTES * 60_000);
  lastTried = '';
  setCode('');
  updateResend();
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
  if (!pending) return;
  const left = Math.ceil((pending.sentAt + RESEND_SECONDS * 1000 - now()) / 1000);
  if (left > 0) { // 閉じたら止める(close の処理)。開き直したときは open() から数え直す
    b.disabled = true;
    b.textContent = `番号を送り直す(${left}秒後)`;
    resendTimer = setTimeout(updateResend, 1000);
  } else {
    b.disabled = busy;
    b.textContent = '番号を送り直す';
  }
}

async function sendCode(email, el) {
  const sent = await run(el, async () => {
    await account.sendCode(email);
    savePending({ email, sentAt: now() });
    return true;
  });
  if (!sent) {
    // 同じアドレスへ送ったばかりで断られた(続けて送れない1分): さきほどの番号がまだ使えるので、番号の画面へ
    const recent = loadPending();
    if (run.lastError?.status === 429 && recent && recent.email === email) {
      pending = recent;
      showCode({ focus: true });
      msg($('#acct-code-msg'), 'さきほど送った番号を入力してください。');
    }
    return;
  }
  showCode({ focus: true });
  if (!h.coarse()) $('#acct-code').focus();
}

async function verify() {
  const code = setCode($('#acct-code').value);
  const el = $('#acct-code-msg');
  if (!pending) { // ほかのタブでログインした・番号が切れたなど
    render({ focus: true });
    return;
  }
  if (code.length < 6) {
    msg(el, '6桁の番号を入力してください。');
    return;
  }
  lastTried = code;
  const ok = await run(el, async () => {
    const r = await account.verify(pending.email, code);
    // 同期先は、サーバーが返した /dav/ の住所(ログインしたサーバーと同じ場所のときだけ使う)
    const base = account.apiBase();
    const url = typeof r.dav === 'string' && r.dav.startsWith(base + '/') ? r.dav : base + '/dav/';
    // ユーザー名には利用者の ID を入れる(同期の進み具合は「URL とユーザー名」ごとに覚えるので、アカウントを替えたら最初から)
    await dav.configure({
      url, user: r.userId, pass: r.token, auto: true,
      account: { email: r.email, deviceId: r.deviceId, deviceLabel: r.deviceLabel },
    });
    savePending(null);
    note = r.removedDevices
      ? 'ログインしました。ログインできる端末は5台までのため、いちばん長く使っていない端末を外しました'
      : 'ログインしました。この端末のノートとほかの端末のノートを同期します';
    return true;
  });
  if (!ok) {
    // 入れた番号は消して、打ち直してもらう(残すと、続けて打った数字や貼り付けた番号が古い番号のまま送られてしまう)
    setCode('');
    if (/あと0回/.test(el.textContent)) msg(el, '間違いが続いたため、この番号は使えません。送り直してください。');
    if (/送り直して/.test(el.textContent)) $('#acct-resend').disabled ? $('#acct-back').focus() : $('#acct-resend').focus();
    else if (!h.coarse()) $('#acct-code').focus();
    return;
  }
  renderInfo({ focus: true }); // 先に管理の画面にする(refresh() が描き直してお知らせを消さないように)
  refresh();
  dav.syncNow(true);
}

function renderInfo({ focus = false } = {}) {
  const acc = dav.config().account;
  show('#acct-info', { focus });
  $('#acct-avatar').textContent = initial(acc.email);
  $('#acct-who').textContent = acc.email;
  $('#acct-since').textContent = acc.deviceLabel ? `この端末: ${acc.deviceLabel}` : '';
  const n = $('#acct-note');
  n.textContent = note;
  n.hidden = !note;
  if ($('#account-dialog').open) note = ''; // 閉じているあいだに描いたときは、次に開いたときにも出す
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
  if (seq !== loadSeq || $('#acct-info').hidden) return;
  if ([me, list].some((r) => r.status === 'rejected' && r.reason.status === 401)) {
    // 鍵が断られた(ほかの端末から外された・退会した): 同期の仕組みに知らせて、ログインの画面に戻す
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
          message: `「${d.label}」では同期が止まり、もう一度ログインするまで使えなくなります。その端末の中のノートは消えません。`,
          ok: '外す',
        });
        if (yes && (await run($('#acct-msg'), async () => { await account.revoke(token(), d.id); return true; }))) loadDetails();
      };
      li.append(b);
    }
    return li;
  }));
}

// ログアウト・退会のあと: この端末の同期を止める(端末の中のノートはそのまま)
async function accountOff() {
  await dav.configure({ url: '', user: '', pass: '', auto: false });
  h.setSyncStatus('クラウド同期はオフです');
  refresh();
}

// ---------- つなぐ ----------

export function init(helpers) {
  h = helpers;
  pending = loadPending();

  $('#account-btn').onclick = open;
  $('#acct-open-login').onclick = () => { $('#sync-dialog').close(); open(); };
  $('#acct-open-manage').onclick = () => { $('#sync-dialog').close(); open(); };
  $('#acct-summary-sync').onclick = () => dav.syncNow(true);
  $('#acct-to-sync').onclick = () => { $('#account-dialog').close(); h.openSync({ webdav: true }); };
  $('#account-dialog').addEventListener('close', () => clearTimeout(resendTimer));
  $('#account-dialog').addEventListener('cancel', (e) => { if (busy) e.preventDefault(); }); // 通信の途中は Esc で閉じない
  $('#acct-local-logout').onclick = () => run($('#acct-email-msg'), async () => {
    await accountOff();
    savePending(null);
    render({ focus: true });
    h.toast('この端末でログアウトしました。この端末のノートはそのまま残っています', 6000);
  });

  $('#acct-email-form').onsubmit = async (e) => {
    e.preventDefault();
    const input = $('#acct-email');
    const email = normalizeEmail(input.value);
    input.value = email;
    const el = $('#acct-email-msg');
    if (!email) return msg(el, 'メールアドレスを入力してください。'), input.focus();
    if (!looksLikeEmail(email)) return msg(el, 'メールアドレスの形式が正しくありません。もう一度確かめてください。'), input.focus();
    // 同じアドレスへ送ったばかりなら、送り直さずに番号の画面へ(続けて送ると断られるため)
    const recent = loadPending();
    if (recent && recent.email === email && now() - recent.sentAt < RESEND_SECONDS * 1000) {
      pending = recent;
      showCode({ focus: true });
      if (!h.coarse()) $('#acct-code').focus();
      return;
    }
    // 自分のサーバー(WebDAV)で同期しているときは、切り替えてよいか先に確かめる
    const cfg = dav.config();
    if (cfg.url && !cfg.account) {
      const yes = await h.askConfirm({
        heading: '大学ノートアカウントに切り替えますか?',
        message: 'ログインすると、自分のサーバー(WebDAV)との同期をやめて、大学ノートアカウントで同期します。端末の中のノートは消えません。',
        ok: '続ける',
      });
      if (!yes) return;
    }
    sendCode(email, el);
  };
  $('#acct-email').oninput = () => msg($('#acct-email-msg'), '');

  const code = $('#acct-code');
  // 入力欄は「後ろに足す・後ろから消す」だけにする(見えないカーソルが途中の桁にあると、見た目と違う桁が変わるため)
  const toEnd = () => { const n = code.value.length; try { code.setSelectionRange(n, n); } catch { /* 対応していない */ } };
  const onCode = () => {
    // 7桁以上になったら(古い番号の後ろに貼り付けた・打ち足した)、新しく入った後ろの6桁を使う
    const digits = normalizeCode(code.value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, '').slice(-6));
    const v = setCode(digits);
    toEnd();
    if (v.length < 6 || v !== lastTried) msg($('#acct-code-msg'), '');
    // 6桁そろったら、そのまま確かめる(貼り付け・自動入力のときも)。断られたのと同じ番号は自動では送らない
    if (v.length === 6 && v !== lastTried) verify();
  };
  // 日本語入力で打っている途中(変換前)は書き換えない(書き換えると数字が重なる)。確定したときに読む
  code.addEventListener('input', (e) => { if (!e.isComposing) onCode(); });
  code.addEventListener('compositionend', onCode);
  for (const ev of ['click', 'keyup', 'select']) code.addEventListener(ev, toEnd);
  for (const ev of ['focus', 'blur']) {
    code.addEventListener(ev, () => {
      $('#acct-code-form .code-box').classList.toggle('focus', document.activeElement === code);
      if (ev === 'focus') setTimeout(toEnd, 0);
    });
  }
  $('#acct-code-form').onsubmit = (e) => { e.preventDefault(); verify(); };
  $('#acct-resend').onclick = () => { if (pending) sendCode(pending.email, $('#acct-code-msg')); };
  // 送った番号は覚えたまま(同じアドレスに戻したら、送り直さずにその番号を入れられる)
  $('#acct-back').onclick = () => {
    editing = true;
    clearTimeout(resendTimer);
    render({ focus: true });
    if (pending) $('#acct-email').value = pending.email;
    if (!h.coarse()) { $('#acct-email').focus(); $('#acct-email').select(); }
  };

  $('#acct-sync').onclick = () => dav.syncNow(true);
  $('#acct-logout').onclick = async () => {
    const yes = await h.askConfirm({
      heading: 'ログアウトしますか?',
      message: 'この端末の同期が止まります。この端末の中のノートは消えずに残り、もう一度ログインすれば同期を再開できます。',
      ok: 'ログアウト',
    });
    if (!yes) return;
    await run($('#acct-msg'), async () => {
      let offline = false;
      // サーバーで鍵を消せなくても(オフラインなど)、この端末ではログアウトする
      try { await account.logout(token()); } catch (err) { offline = err.status !== 401; }
      await accountOff();
      render({ focus: true });
      h.toast(offline
        ? 'サーバーに接続できなかったため、この端末の中だけでログアウトしました。ほかの端末の「ログイン中の端末」から外せます'
        : 'ログアウトしました。この端末のノートはそのまま残っています', 6000);
    });
  };
  $('#acct-delete').onclick = async () => {
    const yes = await h.askConfirm({
      heading: 'アカウントを削除しますか?',
      message: 'サーバーに預けた変更・PDF・画像をすべて削除し、すべての端末でログアウトします。元に戻せません。この端末の中のノートは消えずに残ります(ほかの端末の中のノートも残ります)。',
      ok: '削除する',
      danger: true,
    });
    if (!yes) return;
    await run($('#acct-msg'), async () => {
      await account.deleteAccount(token());
      await accountOff();
      $('#account-dialog').close();
      h.toast('アカウントを削除しました。この端末のノートはそのまま残っています', 6000);
    });
  };
  refresh();
}
