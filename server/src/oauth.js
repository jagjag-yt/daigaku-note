// Apple・Google でのログイン(メールの番号を使わずにログインする)。
//
// 流れ(どの端末でも同じ。アプリに Apple・Google の部品を入れずに済むよう、やりとりはこのサーバーが受け持つ):
//   1. アプリが合言葉(verifier)を作り、そのハッシュ(challenge)を付けて /oauth/<apple|google>/start を開く
//      (ブラウザ版はこのページのまま移る。アプリ版は OS のブラウザの画面で開く)
//   2. サーバーは Apple・Google のログインの画面へ送る。ログインが済むと /oauth/<…>/callback に戻ってくる
//   3. サーバーは Apple・Google から本人の ID とメールアドレスを受け取り、利用者を探す(なければ作る)。
//      一度だけ使える引換券(ticket)を作り、アプリの住所 …#/oauth?ticket=… へ戻す
//   4. アプリは引換券と合言葉を POST /oauth/redeem に送り、端末の鍵を受け取る(メールの番号のログインと同じ形)
//   合言葉は始めた端末にしかないので、引換券を途中で見られても、ほかの端末では使えない
//   (ほかのアプリが同じ住所を名乗った場合や、他人のアカウントに勝手にログインさせる「ログイン CSRF」を防ぐ)。
//
// 受け口:
//   GET  /oauth/providers           { providers: { apple, google } } 設定が済んでいるもの(アプリはボタンを出すかどうかに使う)
//   GET  /oauth/<p>/start?return=…&challenge=…   → Apple・Google のログインの画面へ
//   GET  /oauth/google/callback     Google から戻る
//   POST /oauth/apple/callback      Apple から戻る(メールアドレスを求めると、Apple はフォームの POST で戻すため)
//   POST /oauth/redeem              { ticket, verifier, label } → 端末の鍵(/otp/verify と同じ形)
//
// 設定(wrangler secret put で入れる。入れていないものはボタンが出ない):
//   Google: GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET
//   Apple:  APPLE_CLIENT_ID(Services ID)・APPLE_TEAM_ID・APPLE_KEY_ID・APPLE_PRIVATE_KEY(.p8 の中身をそのまま)
// 戻り先(callback)は https://note-api.quiz-make.com/oauth/google/callback と …/oauth/apple/callback を、
// それぞれ Google Cloud・Apple Developer に登録しておく(手順は server/README.md)。
//
// Apple・Google から受け取る ID トークンは、こちらから直接(TLS で)取りに行ったものだけを使うので、
// 署名の確かめは省き、発行元・宛先・期限・nonce を確かめる(Google・Apple の説明どおり)。

import { allowRate, fail, hashSecret, json, newId, normalizeEmail, looksLikeEmail, nowIso, readJson } from './lib.js';

/** アプリ版(iOS・Android)に戻す住所。アプリの ID と同じ名前の URL スキーム(Info.plist・AndroidManifest.xml に登録) */
export const APP_RETURN = 'io.github.jagjagyt.daigakunote:/auth';

/** ブラウザ版で戻してよい住所(公開しているアプリのページだけ。同じ github.io のほかのページには戻さない) */
const WEB_RETURNS = new Set(['https://jagjag-yt.github.io/daigaku-note/']);
/** 手元の試験でだけ許す住所(vars の DEV_OAUTH_RETURNS が '1' のとき。本番では設定しない) */
const DEV_RETURNS = new Set(['http://localhost:8123/', 'http://localhost:8124/', 'http://localhost:8130/']);

/** 始めてから戻ってくるまで・引換券を使うまでの時間(分) */
const FLOW_MINUTES = 15;

const PROVIDERS = {
  google: {
    name: 'Google',
    configured: (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    authorizeUrl: (env, { redirectUri, state, nonce }) => {
      const q = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email',
        state,
        nonce,
        prompt: 'select_account', // 共有の端末で、前の人の Google アカウントに勝手に入らないように
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    },
    tokenRequest: async (env, { code, redirectUri }) => ({
      url: 'https://oauth2.googleapis.com/token',
      form: { code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' },
    }),
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    clientId: (env) => env.GOOGLE_CLIENT_ID,
  },
  apple: {
    name: 'Apple',
    configured: (env) => !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY),
    authorizeUrl: (env, { redirectUri, state, nonce }) => {
      const q = new URLSearchParams({
        client_id: env.APPLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'email', // 名前は使わないので求めない
        response_mode: 'form_post', // scope を付けるときは form_post だけが使える
        state,
        nonce,
      });
      return `https://appleid.apple.com/auth/authorize?${q}`;
    },
    tokenRequest: async (env, { code, redirectUri }) => ({
      url: 'https://appleid.apple.com/auth/token',
      form: { code, client_id: env.APPLE_CLIENT_ID, client_secret: await appleClientSecret(env), redirect_uri: redirectUri, grant_type: 'authorization_code' },
    }),
    issuers: ['https://appleid.apple.com'],
    clientId: (env) => env.APPLE_CLIENT_ID,
  },
};

// ---- 小さな道具 ----

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (v) => b64url(enc.encode(JSON.stringify(v)));
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
/** PKCE と同じ形: base64url(SHA-256(verifier)) */
export const challengeOf = async (verifier) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));

/** JWT の中身を読む(署名は見ない。直接取りに行ったトークンだけに使う) */
export function decodeJwt(token) {
  const part = String(token ?? '').split('.')[1];
  if (!part) return null;
  try {
    const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

/**
 * Apple に渡す client_secret(Apple の鍵で署名した、5分だけ使える JWT)。
 * APPLE_PRIVATE_KEY は Apple Developer で作った .p8 の中身(-----BEGIN PRIVATE KEY----- から)。
 */
export async function appleClientSecret(env, now = Date.now()) {
  const pem = String(env.APPLE_PRIVATE_KEY).replace(/\\n/g, '\n');
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const iat = Math.floor(now / 1000);
  const head = b64urlJson({ alg: 'ES256', kid: env.APPLE_KEY_ID });
  const claims = b64urlJson({ iss: env.APPLE_TEAM_ID, iat, exp: iat + 300, aud: 'https://appleid.apple.com', sub: env.APPLE_CLIENT_ID });
  // Web Crypto の ECDSA の署名は r||s の64バイト(JWT の ES256 と同じ形)
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(sig)}`;
}

/** 戻り先として許す住所か。許すなら、その住所(正規化したもの)を返す */
export function allowedReturn(value, env = {}) {
  const v = String(value ?? '');
  if (v === APP_RETURN) return v;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.username || u.password) return null;
  const base = `${u.origin}${u.pathname}`; // 問い合わせ・# は付けない(# はこちらで付ける)
  if (WEB_RETURNS.has(base)) return base;
  if (String(env.DEV_OAUTH_RETURNS) === '1' && DEV_RETURNS.has(base)) return base;
  return null;
}

const callbackUrl = (request, provider) => new URL(`/oauth/${provider}/callback`, request.url).href;

/** 戻り先へ送る。結果は # のあとに付ける(# はサーバーに送られないので、アクセスの記録に残らない) */
function backTo(returnTo, params) {
  const target = `${returnTo}#/oauth?${new URLSearchParams(params)}`;
  if (returnTo === APP_RETURN) {
    // アプリへは、リダイレクトではなくページを返し、すぐに移る(meta refresh)うえに、押せるリンクも出す。
    // OS のブラウザの画面(とくに Apple のフォームの POST のあとの Android の Custom Tabs)は、操作なしでアプリの住所へ移るのを止めることがあり、
    // リダイレクトの本文は表示されないため
    const href = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${href}"><title>大学ノート</title>`
      + `<style>body{font:16px/1.6 system-ui,sans-serif;text-align:center;padding:48px 24px;color:#222}a{display:inline-block;margin-top:16px;padding:12px 24px;border-radius:10px;background:#2f6fde;color:#fff;text-decoration:none}</style></head>`
      + `<body><p>大学ノートに戻ります。</p><a href="${href}">大学ノートに戻る</a></body></html>`;
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'x-page-csp': "default-src 'none'; style-src 'unsafe-inline'" },
    });
  }
  return new Response(null, { status: 302, headers: { location: target } });
}

/** 戻り先が分からないときの、ことばだけのページ */
function errorPage(message, status = 400) {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>大学ノート</title>`
    + `<style>body{font:16px/1.6 system-ui,sans-serif;text-align:center;padding:48px 24px;color:#222}</style></head>`
    + `<body><p>${message}</p><p>この画面を閉じて、大学ノートからもう一度お試しください。</p></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-page-csp': "default-src 'none'; style-src 'unsafe-inline'" } });
}

// ---- 受け口 ----

/** 設定が済んでいる方法 */
export function providersOf(env) {
  return Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, p.configured(env)]));
}

/**
 * /oauth/ 以下をさばく。当てはまらなければ null。
 * tools: { clientIp, loginUser, issueDevice }(index.js から受け取る。同じ処理をメールの番号のログインと分け合うため)
 */
export async function handleOAuth(request, env, url, tools) {
  const m = /^\/oauth\/(?:(providers|redeem)|(apple|google)\/(start|callback))$/.exec(url.pathname);
  if (!m) return null;
  if (m[1] === 'providers' && request.method === 'GET') return json({ ok: true, providers: providersOf(env) });
  if (m[1] === 'redeem' && request.method === 'POST') return redeem(request, env, tools);
  const provider = m[2];
  if (m[3] === 'start' && request.method === 'GET') return start(request, env, url, provider, tools);
  if (m[3] === 'callback' && provider === 'google' && request.method === 'GET') {
    return callback(request, env, provider, Object.fromEntries(url.searchParams), tools);
  }
  if (m[3] === 'callback' && provider === 'apple' && request.method === 'POST') {
    let form = {};
    try { form = Object.fromEntries(await request.formData()); } catch { /* 空のまま */ }
    return callback(request, env, provider, form, tools);
  }
  return fail(405, 'この方法では使えません。');
}

async function start(request, env, url, provider, { clientIp }) {
  const p = PROVIDERS[provider];
  const returnTo = allowedReturn(url.searchParams.get('return'), env);
  const challenge = String(url.searchParams.get('challenge') ?? '');
  if (!returnTo || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return errorPage('ログインを始められませんでした(住所が正しくありません)。');
  if (!p.configured(env)) return backTo(returnTo, { error: 'unavailable', provider });
  // 始めるたびに1行できるので、IP ごとに数える(行を作り続けられないように)
  const ip = clientIp(request);
  // IPv6 は /64 に加えて /48 でも数える(/48 をまるごと借りられるサービスがあるため)
  const ip48 = ip && ip.endsWith('::/64') ? `${ip.split(':').slice(0, 3).join(':')}::/48` : null;
  if (ip && !(await allowRate(env.DB, `oauth:start:${ip}`, 30, 60 * 60))) return backTo(returnTo, { error: 'rate', provider });
  if (ip48 && !(await allowRate(env.DB, `oauth:start:${ip48}`, 100, 60 * 60))) return backTo(returnTo, { error: 'rate', provider });

  const state = randomToken();
  const nonce = randomToken();
  const expiresAt = new Date(Date.now() + FLOW_MINUTES * 60_000).toISOString();
  await env.DB.prepare('INSERT INTO oauth_flows (state, provider, challenge, return_to, nonce, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(state, provider, challenge, returnTo, nonce, expiresAt, nowIso()).run();
  return new Response(null, { status: 302, headers: { location: p.authorizeUrl(env, { redirectUri: callbackUrl(request, provider), state, nonce }) } });
}

async function callback(request, env, provider, params, tools) {
  const p = PROVIDERS[provider];
  const state = String(params.state ?? '');
  // state は1回だけ使える(取り出すときに消す)
  const flow = state && /^[A-Za-z0-9_-]{43}$/.test(state)
    ? await env.DB.prepare('DELETE FROM oauth_flows WHERE state = ? AND provider = ? AND ticket_hash IS NULL RETURNING challenge, return_to, nonce, expires_at')
      .bind(state, provider).first()
    : null;
  if (!flow) return errorPage('ログインの途中の情報が見つかりません。時間がたちすぎたか、すでに使われています。');
  const back = (params2) => backTo(flow.return_to, { provider, ...params2 });
  if (Date.parse(flow.expires_at) <= Date.now()) return back({ error: 'expired' });
  // 利用者が取り消した(Apple は user_cancelled_authorize、Google は access_denied)
  if (params.error) return back({ error: /cancel|denied/.test(String(params.error)) ? 'cancelled' : 'failed' });
  if (!params.code) return back({ error: 'failed' });

  // 引き換え: こちらから直接 Apple・Google に聞く
  let claims;
  let refreshToken = null;
  try {
    const redirectUri = callbackUrl(request, provider);
    const req = await p.tokenRequest(env, { code: String(params.code), redirectUri });
    const res = await fetch(req.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(req.form),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.id_token) {
      // 鍵が入っているかもしれないので、理由だけをログに出す
      console.log(`oauth ${provider} token failed`, res.status, String(data?.error ?? ''), String(data?.error_description ?? '').slice(0, 200));
      return back({ error: 'failed' });
    }
    claims = decodeJwt(data.id_token);
    if (provider === 'apple' && typeof data.refresh_token === 'string') refreshToken = data.refresh_token;
  } catch (err) {
    console.log(`oauth ${provider} token error`, String(err));
    return back({ error: 'failed' });
  }
  const now = Date.now() / 1000;
  if (!claims || !p.issuers.includes(claims.iss) || !audOk(claims.aud, p.clientId(env)) || !(claims.exp > now) || claims.nonce !== flow.nonce || !claims.sub) {
    console.log(`oauth ${provider} bad id_token`, JSON.stringify({ iss: claims?.iss, aud: claims?.aud, exp: claims?.exp, nonceOk: claims?.nonce === flow.nonce }));
    return back({ error: 'failed' });
  }
  const email = normalizeEmail(claims.email);
  const verified = (claims.email_verified === true || claims.email_verified === 'true') && looksLikeEmail(email);
  const owns = verified && ownsEmail(provider, email, claims);
  try {
    const r = await tools.loginUser(env, { provider, subject: String(claims.sub), email: verified ? email : null, owns, refreshToken });
    if (r.error) return back({ error: r.error });

    // 引換券。ハッシュだけを持つ。合言葉(challenge)と一緒に、もう一度行を作る(state はもう使えない)
    const ticket = randomToken();
    const ticketHash = await hashSecret(ticket, env.SECRET_PEPPER);
    await env.DB.prepare('INSERT INTO oauth_flows (state, provider, challenge, return_to, nonce, expires_at, created_at, ticket_hash, user_id, existing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(newId('t'), provider, flow.challenge, flow.return_to, '', new Date(Date.now() + 5 * 60_000).toISOString(), nowIso(), ticketHash, r.userId, r.existing ? 1 : 0)
      .run();
    return back({ ticket });
  } catch (err) {
    // データベースの一時的な失敗など。state はもう使えないので、アプリに戻して、もう一度始めてもらう
    console.log(`oauth ${provider} login error`, String(err));
    return back({ error: 'failed' });
  }
}

/**
 * そのアドレスの今の持ち主だと言い切れるか。言い切れるときだけ、前からあるアカウントにつなぐ(src/index.js の loginUser)。
 *   Google: Google が管理しているアドレス(Gmail、または Google Workspace = hd がある)
 *   Apple:  Apple が作った転送用のアドレス(「メールを非公開」)か、iCloud のアドレス
 * それ以外(Google・Apple のアカウントにほかの会社のアドレスを付けた人)は、作ったときに確かめただけで、
 * 今も持っているとは限らない(卒業した大学のアドレスなど)
 */
export function ownsEmail(provider, email, claims) {
  const domain = email.split('@')[1];
  if (provider === 'google') return domain === 'gmail.com' || domain === 'googlemail.com' || !!claims.hd;
  if (provider === 'apple') return claims.is_private_email === true || claims.is_private_email === 'true' || ['icloud.com', 'me.com', 'mac.com'].includes(domain);
  return false;
}

/** Apple に、このアプリへのログインの取り消しを頼む(退会のとき。失敗しても投げない) */
export async function revokeApple(env, refreshToken) {
  if (!PROVIDERS.apple.configured(env) || !refreshToken) return;
  try {
    const res = await fetch('https://appleid.apple.com/auth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.APPLE_CLIENT_ID, client_secret: await appleClientSecret(env), token: refreshToken, token_type_hint: 'refresh_token' }),
    });
    if (!res.ok) console.log('apple revoke failed', res.status);
  } catch (err) {
    console.log('apple revoke error', String(err));
  }
}

const audOk = (aud, clientId) => (Array.isArray(aud) ? aud.includes(clientId) : aud === clientId);

async function redeem(request, env, { clientIp, issueDevice }) {
  const body = await readJson(request);
  const ticket = String(body?.ticket ?? '');
  const verifier = String(body?.verifier ?? '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket) || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return fail(400, '入力の形式が正しくありません。');
  const ip = clientIp(request);
  if (ip && !(await allowRate(env.DB, `oauth:redeem:${ip}`, 60, 60 * 60))) return fail(429, '回数が上限に達しました。しばらく待ってからお試しください。');
  // 1回だけ使える(取り出すときに消す。合言葉が違っても消す = 何度も試せない)
  const ticketHash = await hashSecret(ticket, env.SECRET_PEPPER);
  const row = await env.DB.prepare('DELETE FROM oauth_flows WHERE ticket_hash = ? RETURNING challenge, user_id, existing, expires_at').bind(ticketHash).first();
  if (!row || Date.parse(row.expires_at) <= Date.now()) return fail(400, 'ログインの期限が切れました。もう一度お試しください。');
  if ((await challengeOf(verifier)) !== row.challenge) return fail(400, 'ログインを始めた端末と違うため、ログインできません。もう一度お試しください。');
  const user = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(row.user_id).first();
  if (!user) return fail(400, 'アカウントが見つかりません。もう一度お試しください。');
  return issueDevice(request, env, user, { label: body?.label, existing: !!row.existing });
}

/** 期限が切れた行の掃除(週1回の定期実行から) */
export const cleanupOAuth = (env) => env.DB.prepare('DELETE FROM oauth_flows WHERE expires_at <= ?').bind(nowIso()).run();
