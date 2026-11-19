// かきためノートアカウント(同期サーバー server/ へのログイン)。
// メールアドレスに届く6桁の番号でログインし、受け取った鍵で同期サーバーの /dav/ を WebDAV として使う(js/webdav.js)。
//
// サーバーの住所はふだん API_BASE。試験・開発のときだけ、localStorage の 'daigaku-note.api' で別の住所にできる
// (例: localStorage.setItem('daigaku-note.api', 'http://localhost:8787'))。
// アプリ版は OS の通信機能で送る(js/native.js の http。CORS を通らない)。
import { http, isNative, platform } from './native.js';

export const API_BASE = 'https://note-api.quiz-make.com';

export function apiBase() {
  try {
    const v = globalThis.localStorage?.getItem('daigaku-note.api');
    // 開発・試験用に変えられるのは、手元のサーバーだけ(ほかの住所にすると、ログインの番号や鍵がそこへ送られるため)
    if (v && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(v)) return v;
  } catch { /* 使えない環境(プライベートブラウズなど)ではふだんの住所 */ }
  return API_BASE;
}

// サーバーを呼ぶ。失敗したら、利用者に見せる文言を message に入れたエラー(status 付き)を投げる
async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctl = new AbortController();
  const t = isNative ? 0 : setTimeout(() => ctl.abort(), 30_000);
  let res;
  try {
    res = await http(apiBase() + path, { method, headers, body: body === undefined ? null : JSON.stringify(body), signal: ctl.signal, idleTimeout: 30_000 });
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'サーバーからの応答がありません(時間切れ)。しばらくしてからお試しください。' : 'サーバーに接続できません。ネット接続を確かめてください。');
    err.status = 0;
    throw err;
  } finally {
    clearTimeout(t);
  }
  let data = null;
  try { data = await res.json(); } catch { /* 本文なし */ }
  if (!res.ok || !data || data.ok === false) {
    const err = new Error(data?.message || `サーバーでエラーが起きました(${res.status})`);
    err.status = res.status;
    err.reason = data?.reason; // 'no_account'(ログインしようとしたアドレスにアカウントがない)・'unverified_owner' など
    err.via = data?.via; // unverified_owner のとき、そのアカウントを作った方法('apple' | 'google')
    throw err;
  }
  return data;
}

// 端末の名前(ほかの端末の一覧で見分けるため)。ブラウザはサーバーが User-Agent から作る
const label = () => (isNative ? (platform === 'ios' ? 'iPhone・iPad のアプリ' : 'Android のアプリ') : undefined);

// purpose: 'login'(ログイン)・'signup'(アカウント作成)
export const sendCode = (email, purpose) => call('/otp/send', { method: 'POST', body: { email, purpose } });
// → { token, email, userId, deviceId, deviceLabel, dav, removedDevices, maxDevices, existing }
// ログインでアカウントがなければ、reason: 'no_account' のエラー(番号は使用済みにならない)
// replace: Apple・Google から(持ち主を確かめずに)作られたアカウントがあっても、新しいアカウントを作る(reason: 'unverified_owner' のあと)
export const verify = (email, code, purpose, replace = false) => call('/otp/verify', { method: 'POST', body: { email, code, purpose, label: label(), ...(replace ? { replace: true } : {}) } });
export const me = (token) => call('/me', { token });
export const devices = (token) => call('/devices', { token }).then((d) => d.devices);
export const revoke = (token, id) => call(`/devices?id=${encodeURIComponent(id)}`, { method: 'DELETE', token });
export const logout = (token) => call('/logout', { method: 'POST', token });
export const deleteAccount = (token) => call('/account', { method: 'DELETE', token });
// クーポンコードを使う → { perk, name, expiresAt, perks }
export const redeemCoupon = (token, code) => call('/coupon', { method: 'POST', body: { code }, token });

// 特典(クーポンなどで付いたもの)を端末に覚えておく。オフラインでも「広告なし」などを判断できるように。
// サーバーの /me・/coupon の perks を受け取るたびに書き直す。ログアウトしたら消す。
const PERKS_KEY = 'daigaku-note.perks';
export function savePerks(userId, perks, adFree) {
  try {
    if (!userId) globalThis.localStorage?.removeItem(PERKS_KEY);
    else globalThis.localStorage?.setItem(PERKS_KEY, JSON.stringify({ userId, perks: Array.isArray(perks) ? perks : [], adFree: !!adFree }));
  } catch { /* 保存できない環境では、毎回サーバーに聞く */ }
}
/** 端末に覚えた特典の一覧。そのアカウントのものがなければ null */
export function cachedPerks(userId) {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(PERKS_KEY) || 'null');
    return v && userId && v.userId === userId && Array.isArray(v.perks) ? v.perks : null;
  } catch {
    return null;
  }
}
/**
 * 広告を出さないか(Pro・Max・広告なしの特典)。端末に覚えたものだけで決める。
 * 広告を出すときに使う予定(広告はまだ入っていない)。userId は今ログインしているアカウント。ログインしていなければ false
 */
export function adFree(userId) {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(PERKS_KEY) || 'null');
    return !!(v && userId && v.userId === userId && (v.adFree || hasPerk('adfree', userId)));
  } catch {
    return false;
  }
}
/**
 * その特典をいま持っているか(端末に覚えたものだけで決める。通信はしない)。
 * 広告を出すときに使う予定(広告はまだ入っていない)。userId は今ログインしているアカウント
 */
export function hasPerk(perk, userId) {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(PERKS_KEY) || 'null');
    if (!v || !userId || v.userId !== userId) return false;
    return v.perks.some((p) => p.perk === perk && (!p.expiresAt || Date.parse(p.expiresAt) > Date.now()));
  } catch {
    return false;
  }
}

// ---- Apple・Google でのログイン(サーバーは server/src/oauth.js) ----
// 1. oauthStartUrl() で合言葉(verifier)を作って端末に覚え、サーバーの /oauth/<p>/start の住所を返す
// 2. その住所を開く(ブラウザ版はこのページのまま移る。アプリ版は OS のブラウザの画面。js/native.js の openAuthPage)
// 3. Apple・Google でログインすると、…#/oauth?ticket=… に戻ってくる。takeOAuth() で覚えた合言葉を取り出し、
//    oauthRedeem() で引換券と一緒に送ると、メールの番号のログインと同じ形の結果が返る
// 合言葉は始めた端末にしか残らないので、引換券だけを手に入れても、ほかの端末ではログインできない。

/** アプリ版で戻ってくる住所(server/src/oauth.js の APP_RETURN。Info.plist・AndroidManifest.xml に登録してある) */
export const APP_RETURN = 'io.github.jagjagyt.daigakunote:/auth';
const OAUTH_KEY = 'daigaku-note.oauth';
const OAUTH_MINUTES = 15; // サーバーで始めてから戻るまでの時間(server/src/oauth.js の FLOW_MINUTES)
export const PROVIDER_NAMES = { apple: 'Apple', google: 'Google' };

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 使える方法 { apple: true/false, google: true/false }(サーバーで設定が済んだもの) */
export const oauthProviders = () => call('/oauth/providers').then((d) => d.providers || {});

/**
 * ログインを始める住所を作る。purpose はどのページから始めたか(戻ったときに同じページに文言を出すため)。
 * 端末に覚えられないとき(プライベートブラウズなど)は、エラーを投げる
 */
export async function oauthStartUrl(provider, purpose) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  try {
    localStorage.setItem(OAUTH_KEY, JSON.stringify({ provider, verifier, purpose, at: Date.now() }));
  } catch {
    const err = new Error('この画面ではログインの途中の情報を保存できません。プライベートブラウズを使っていたら、ふつうの画面でお試しください。');
    err.status = 0;
    throw err;
  }
  const ret = isNative ? APP_RETURN : location.origin + location.pathname.replace(/index\.html$/, '');
  return `${apiBase()}/oauth/${provider}/start?${new URLSearchParams({ return: ret, challenge })}`;
}

/** 始めたときに覚えた情報 { provider, verifier, purpose }。消さずに読むだけ(戻ったときに、どのページに出すかを決めるため) */
export function peekOAuth() {
  try {
    const v = JSON.parse(localStorage.getItem(OAUTH_KEY) || 'null');
    if (v && typeof v.verifier === 'string' && Date.now() - v.at < OAUTH_MINUTES * 60_000) return v;
  } catch { /* なし */ }
  return null;
}
/** 覚えた情報を取り出して消す(1回だけ使う) */
export function takeOAuth() {
  const v = peekOAuth();
  try { localStorage.removeItem(OAUTH_KEY); } catch { /* なし */ }
  return v;
}

/** 引換券と合言葉を送って、端末の鍵を受け取る → verify() と同じ形 */
export const oauthRedeem = (ticket, verifier) => call('/oauth/redeem', { method: 'POST', body: { ticket, verifier, label: label() } });

/** 戻ってきた住所(#/oauth?… を含むもの)から、結果を読む。当てはまらなければ null */
export function parseOAuthReturn(url) {
  const i = String(url || '').indexOf('#/oauth?');
  if (i < 0) return null;
  const q = new URLSearchParams(String(url).slice(i + '#/oauth?'.length));
  const provider = q.get('provider');
  return { provider: PROVIDER_NAMES[provider] ? provider : null, ticket: q.get('ticket'), error: q.get('error'), via: q.get('via') };
}
