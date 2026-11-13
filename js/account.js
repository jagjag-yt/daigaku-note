// 大学ノートアカウント(同期サーバー server/ へのログイン)。
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
    if (v && /^https?:\/\/[^/]+$/.test(v)) return v;
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
    const err = new Error(e.name === 'AbortError' ? 'サーバーからの応答がありません(時間切れ)。しばらくしてからお試しください' : 'サーバーに接続できません。ネット接続を確かめてください');
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
    throw err;
  }
  return data;
}

// 端末の名前(ほかの端末の一覧で見分けるため)。ブラウザはサーバーが User-Agent から作る
const label = () => (isNative ? (platform === 'ios' ? 'iPhone・iPad のアプリ' : 'Android のアプリ') : undefined);

export const sendCode = (email) => call('/otp/send', { method: 'POST', body: { email } });
// → { token, email, userId, deviceId, deviceLabel, dav, removedDevices }
export const verify = (email, code) => call('/otp/verify', { method: 'POST', body: { email, code, label: label() } });
export const me = (token) => call('/me', { token });
export const devices = (token) => call('/devices', { token }).then((d) => d.devices);
export const revoke = (token, id) => call(`/devices?id=${encodeURIComponent(id)}`, { method: 'DELETE', token });
export const logout = (token) => call('/logout', { method: 'POST', token });
export const deleteAccount = (token) => call('/account', { method: 'DELETE', token });
