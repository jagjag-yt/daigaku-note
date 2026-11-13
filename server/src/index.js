// 大学ノートの同期サーバー(Cloudflare Workers + D1 + R2 + Resend)。
//
// できること: メールアドレスと6桁の番号でログインし、その鍵でクラウド同期の置き場(/dav/)を使う。
// アプリから見ると /dav/ は WebDAV のファイル置き場で、js/webdav.js がそのまま使える(src/dav.js)。
// WebDAV の URL・ユーザー名・アプリパスワードを手で入れなくても、ログインするだけで同期できるようにするためのもの。
//
// 受け口:
//   GET    /health            動いている版
//   POST   /otp/send          { email } → 6桁の番号をメールで送る
//   POST   /otp/verify        { email, code, label } → 端末の鍵(token)を返す。初めてのアドレスならここで利用者を作る
//   GET    /me                ログイン中の利用者・端末・使っている量
//   GET    /devices           ログイン中の端末の一覧
//   DELETE /devices?id=…      端末を1台外す(なくした端末など)
//   POST   /logout            この端末を外す
//   DELETE /account           退会(預かった変更・PDF・画像も全部消す)
//   *      /dav/…             同期の置き場(MKCOL・PROPFIND・PUT・GET・HEAD)
//
// 鍵の渡し方(/me などと /dav/ のどちらも):
//   Authorization: Bearer <token>
//   Authorization: Basic base64(<なんでも>:<token>)  … パスワードに鍵を入れる。ユーザー名は見ない。
//     今のアプリ(js/webdav.js)は Basic で送るので、URL に https://<ここ>/dav/、パスワードに鍵を入れれば、そのまま同期できる。
//
// 方針:
//   ・秘密(6桁の数字・鍵)はハッシュだけを保存する。比べるときは長さをそろえて比べる。
//   ・「そのアドレスが登録されているか」は、どの応答からも分からないようにする。
//   ・番号の送信・確かめ・書き込みには回数の上限を付ける。

import {
  allowRate,
  deviceLabel,
  fail,
  hashSecret,
  json,
  looksLikeEmail,
  newId,
  newOtpCode,
  normalizeEmail,
  normalizeLabel,
  nowIso,
  readJson,
  safeEqual,
} from './lib.js';
import { QUOTA_BYTES, handleDav, parseDavPath } from './dav.js';

/**
 * 配信されている版。/health に載せて、外から「どれが動いているか」を確かめられるようにする。
 * 受け口を足したり応答を変えたりしたら、この文字列も更新すること。
 */
export const API_VERSION = '2026-11-13-dav';

/** 1人が同時にログインできる端末の数。超えたら、いちばん長く使っていない端末を外す。 */
const MAX_DEVICES = 5;

/** この日数使われなかった端末の鍵は無効にして消す。長い休みでも切れない長さにする。 */
const TOKEN_IDLE_DAYS = 180;

/** 6桁の数字の有効期限(分)と、間違えられる回数。 */
const OTP_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

/** 続けて番号を送れない間隔(秒)。手元の試験だけ短くできる(本番では設定しない = 60秒)。 */
const otpBurstSeconds = (env) => Number(env.OTP_BURST_SECONDS ?? 60);

/**
 * 許可する呼び出し元(CORS)。
 * アプリ版(Android・iOS)は OS の通信機能で送るので CORS を通らないが、念のためアプリの画面の住所も入れておく。
 * 鍵は Authorization で明示して送る(クッキーは使わない)ので、ここは「鍵を持っていないページに使わせない」ための補助。
 */
const ALLOWED_ORIGINS = new Set([
  'https://jagjag-yt.github.io', // 公開しているアプリ(GitHub Pages)
  'http://localhost:8123', // npm start
  'http://localhost:8124', // 画面のテスト(test/e2e.cjs など)
  'capacitor://localhost', // iOS のアプリ
  'https://localhost', // Android のアプリ
]);

function corsHeaders(request) {
  const origin = request.headers.get('origin') ?? '';
  if (!ALLOWED_ORIGINS.has(origin)) return { vary: 'origin' };
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS, PROPFIND, MKCOL',
    'access-control-allow-headers': 'authorization, depth, content-type',
    'access-control-expose-headers': 'etag',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

/**
 * 呼び出し元の IP。Cloudflare のネットワークを通った要求(本番)にだけ値が入る。
 * 手元の wrangler dev はループバックを付けることがあるので、それは「付いていない」ものとして扱う。
 */
function clientIp(request) {
  const ip = request.headers.get('cf-connecting-ip');
  return !ip || ip === '127.0.0.1' || ip === '::1' ? null : ip;
}

/**
 * 手元の試験で、送ったはずの6桁を応答に含めるか(メールを読めないため)。
 * Cloudflare を通った要求には必ず cf-connecting-ip が付くので、本番ではこの設定を入れても返さない。
 */
const shouldEchoOtp = (request, env) => String(env.DEV_ECHO_OTP) === '1' && !clientIp(request);

/** Authorization から鍵を取り出す(Bearer と、パスワードに鍵を入れた Basic)。 */
function tokenFrom(request) {
  const header = request.headers.get('authorization') ?? '';
  let token = '';
  if (/^Bearer /i.test(header)) token = header.slice(7).trim();
  else if (/^Basic /i.test(header)) {
    try {
      const decoded = atob(header.slice(6).trim());
      const i = decoded.indexOf(':');
      token = i >= 0 ? decoded.slice(i + 1) : '';
    } catch {
      token = '';
    }
  }
  // 鍵の形(dn_ + 16進64桁)でなければ、データベースを引かずに断る
  return /^dn_[0-9a-f]{64}$/.test(token) ? token : '';
}

/** 鍵から端末と利用者を引く。なければ null。 */
async function authenticate(request, env) {
  const token = tokenFrom(request);
  if (!token) return null;
  // 鍵はハッシュの一致で引く(ハッシュには SECRET_PEPPER が混ざっているので、外から狙った値を作れない)
  const tokenHash = await hashSecret(token, env.SECRET_PEPPER);
  const device = await env.DB.prepare(
    'SELECT d.id, d.user_id, d.label, d.last_used_at, u.email, u.created_at AS user_created_at, u.ver, u.bytes_used ' +
      'FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?',
  ).bind(tokenHash).first();
  if (!device) return null;
  // 長いあいだ使われなかった鍵は、ここで無効にして消す
  if (Date.parse(device.last_used_at) < Date.now() - TOKEN_IDLE_DAYS * 86_400_000) {
    await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(device.id).run();
    return null;
  }
  // 使った時刻は1時間に1回だけ書く(同期は1分ごとに来るので、毎回書くと書き込みの無料枠を無駄に使う)
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  await env.DB.prepare('UPDATE devices SET last_used_at = ? WHERE id = ? AND last_used_at < ?').bind(nowIso(), device.id, hourAgo).run();
  return device;
}

// ---- ログイン -------------------------------------------------------------

/**
 * 6桁の数字を送る。
 * 「そのアドレスが登録されているか」は返さない(どのアドレスが使われているかを調べられないように)。
 * 登録があってもなくても、同じ処理・同じ応答にする(利用者を作るのは番号を確かめたとき)。
 */
async function handleOtpSend(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!looksLikeEmail(email)) return fail(400, 'メールアドレスの形式が正しくありません。');

  const ip = clientIp(request);
  const okEmail = await allowRate(env.DB, `otp:send:${email}`, 20, 24 * 60 * 60);
  const okIp = !ip || (await allowRate(env.DB, `otp:ip:${ip}`, 30, 60 * 60));
  const okBurst = await allowRate(env.DB, `otp:burst:${email}`, 1, otpBurstSeconds(env));
  if (!okEmail || !okIp) return fail(429, '送信の回数が上限に達しました。しばらく待ってからお試しください。');
  if (!okBurst) return fail(429, '続けて送信できません。1分ほど待ってからお試しください。');

  const code = newOtpCode();
  const codeHash = await hashSecret(code, env.SECRET_PEPPER);
  const expiresAt = new Date(Date.now() + OTP_MINUTES * 60_000).toISOString();
  await env.DB.prepare('INSERT INTO otp_requests (id, email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)')
    .bind(newId('otp'), email, codeHash, expiresAt, nowIso())
    .run();

  const echo = shouldEchoOtp(request, env);
  const sent = echo ? { ok: true } : await sendOtpMail(env, email, code);
  // 送れなかったことは伝える(黙って成功にすると、届かない理由が分からなくなる)
  if (!sent.ok) return fail(502, 'メールを送れませんでした。時間をおいてお試しください。');
  return json({ ok: true, expiresInMinutes: OTP_MINUTES, ...(echo ? { devCode: code } : {}) });
}

/** Resend でメールを送る。 */
async function sendOtpMail(env, email, code) {
  const body = {
    from: env.MAIL_FROM,
    to: [email],
    subject: `大学ノートのログイン番号: ${code}`,
    text: [
      '大学ノートのクラウド同期のログイン番号は次のとおりです。',
      '',
      `    ${code}`,
      '',
      `この番号は ${OTP_MINUTES} 分で使えなくなります。`,
      'お心当たりがない場合は、このメールを破棄してください(番号を誰にも教えないでください)。',
      '',
      '大学ノート https://jagjag-yt.github.io/daigaku-note/',
    ].join('\n'),
  };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.log('resend failed', res.status, await res.text());
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.log('resend error', String(err));
    return { ok: false };
  }
}

/** 6桁の数字を確かめ、端末に鍵を渡す。 */
async function handleOtpVerify(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const code = String(body?.code ?? '').trim();
  if (!looksLikeEmail(email) || !/^\d{6}$/.test(code)) return fail(400, '入力の形式が正しくありません。');

  // 総当たりを防ぐ。1つの番号あたり5回の上限に加えて、アドレスごと(IP も含めて)・IP ごとにも数える。
  // アドレスだけで数えると、他人がそのアドレスへ連打するだけで本人がログインできなくなる
  const ip = clientIp(request);
  const okEmail = await allowRate(env.DB, `otp:verify:${email}${ip ? `:${ip}` : ''}`, 30, 60 * 60);
  const okIp = !ip || (await allowRate(env.DB, `otp:verify:ip:${ip}`, 100, 60 * 60));
  if (!okEmail || !okIp) return fail(429, '確かめる回数が上限に達しました。しばらく待ってからお試しください。');

  const row = await env.DB.prepare(
    'SELECT id, code_hash, expires_at, consumed_at FROM otp_requests WHERE email = ? ORDER BY created_at DESC LIMIT 1',
  ).bind(email).first();
  if (!row || row.consumed_at) return fail(400, '番号が見つかりません。送り直してください。');
  if (Date.parse(row.expires_at) <= Date.now()) return fail(400, '番号の有効期限が切れています。送り直してください。');

  // 1回ぶんの試行を、比べる前に1つの命令で取る(同時にたくさん送っても5回の上限をすり抜けない)
  const claim = await env.DB.prepare(
    'UPDATE otp_requests SET attempts = attempts + 1 WHERE id = ? AND attempts < ? AND consumed_at IS NULL RETURNING attempts',
  ).bind(row.id, OTP_MAX_ATTEMPTS).first();
  if (!claim) return fail(429, '間違いが続いたため、この番号は使えません。送り直してください。');

  const codeHash = await hashSecret(code, env.SECRET_PEPPER);
  if (!safeEqual(codeHash, row.code_hash)) {
    return fail(400, `番号が違います。あと${Math.max(0, OTP_MAX_ATTEMPTS - claim.attempts)}回まで試せます。`);
  }
  // 使用済みにする。同時に正しい番号が2回届いても、鍵を出すのは1回だけ
  const consumed = await env.DB.prepare('UPDATE otp_requests SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL RETURNING id')
    .bind(nowIso(), row.id).first();
  if (!consumed) return fail(400, '番号が見つかりません。送り直してください。');

  // 利用者を用意する(初めてのアドレスはここで作る。同時に2回来ても1人だけ)
  await env.DB.prepare('INSERT INTO users (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING')
    .bind(newId('u'), email, nowIso(), nowIso()).run();
  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(nowIso(), user.id).run();

  // 端末が多いときは、いちばん長く使っていないものを外す
  const devices = await env.DB.prepare('SELECT id FROM devices WHERE user_id = ? ORDER BY last_used_at ASC, created_at ASC').bind(user.id).all();
  const over = devices.results.length - (MAX_DEVICES - 1);
  const removed = over > 0 ? devices.results.slice(0, over).map((d) => d.id) : [];
  for (const id of removed) await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(id).run();

  const token = `dn_${newId('k').slice(2)}${newId('k').slice(2)}`;
  const tokenHash = await hashSecret(token, env.SECRET_PEPPER);
  const label = normalizeLabel(body?.label) ?? deviceLabel(request.headers.get('user-agent'));
  const deviceId = newId('d');
  await env.DB.prepare('INSERT INTO devices (id, user_id, token_hash, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(deviceId, user.id, tokenHash, label, nowIso(), nowIso()).run();

  return json({
    ok: true,
    token,
    email,
    userId: user.id,
    deviceId,
    deviceLabel: label,
    removedDevices: removed.length,
    // 同期の置き場の URL(アプリはこれを WebDAV の URL として使う)
    dav: new URL('/dav/', request.url).href,
  });
}

// ---- ログイン中の操作 -----------------------------------------------------

function handleMe(env, device) {
  return json({
    ok: true,
    email: device.email,
    userId: device.user_id,
    createdAt: device.user_created_at,
    deviceId: device.id,
    deviceLabel: device.label,
    usage: { bytes: device.bytes_used, quota: Number(env.QUOTA_BYTES) || QUOTA_BYTES },
  });
}

async function handleDevices(env, device) {
  const rows = await env.DB.prepare('SELECT id, label, created_at, last_used_at FROM devices WHERE user_id = ? ORDER BY last_used_at DESC')
    .bind(device.user_id).all();
  return json({
    ok: true,
    devices: rows.results.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at, current: r.id === device.id })),
  });
}

/** 端末を1台外す。外せるのは自分の端末だけ。この端末を外したときは、ログアウトと同じ。 */
async function handleDeviceDelete(url, env, device) {
  const id = String(url.searchParams.get('id') ?? '').slice(0, 40);
  const gone = await env.DB.prepare('DELETE FROM devices WHERE id = ? AND user_id = ? RETURNING id').bind(id, device.user_id).first();
  if (!gone) return fail(404, 'その端末は見つかりません。');
  return json({ ok: true });
}

/**
 * 退会。預かった変更・PDF・画像・端末・ログインの番号をすべて消す。
 *   1. 先に全部の端末の鍵を消す(消している途中に新しく書き込まれないように)
 *   2. R2 の PDF・画像を消す
 *   3. D1 の残りを1つの batch で消す
 * 2 で失敗したら、利用者の行は残る。もう一度ログインして退会すれば、続きから消せる。
 */
async function handleDeleteAccount(env, device) {
  const uid = device.user_id;
  await env.DB.prepare('DELETE FROM devices WHERE user_id = ?').bind(uid).run();
  try {
    await deletePrefix(env.FILES, `u/${uid}/`);
  } catch (err) {
    console.log('r2 delete failed', String(err));
    return fail(500, '途中で失敗しました。もう一度ログインしてから、退会をやり直してください。');
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM op_files WHERE user_id = ?').bind(uid),
    env.DB.prepare('DELETE FROM op_logs WHERE user_id = ?').bind(uid),
    env.DB.prepare('DELETE FROM blobs WHERE user_id = ?').bind(uid),
    env.DB.prepare('DELETE FROM otp_requests WHERE email = ?').bind(String(device.email ?? '').toLowerCase()),
    env.DB.prepare('DELETE FROM rate_limits WHERE bucket = ?').bind(`dav:w:${uid}`),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(uid),
  ]);
  return json({ ok: true });
}

/** R2 の、名前が prefix で始まるものを全部消す(1回に1000個ずつ)。 */
async function deletePrefix(bucket, prefix) {
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/**
 * 溜まり続ける行の掃除と、使っている量の数え直し(週1回の定期実行)。
 *   ・期限が切れた回数制限、1日以上前に期限が切れたログインの番号、長く使われていない端末の鍵
 *   ・users.bytes_used を、変更のファイルと PDF・画像の大きさの合計に合わせ直す(途中で止まった書き込みなどで、ずれていたら)
 */
export async function cleanup(env) {
  const now = nowIso();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const idle = new Date(Date.now() - TOKEN_IDLE_DAYS * 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM otp_requests WHERE expires_at <= ?').bind(dayAgo),
    env.DB.prepare('DELETE FROM devices WHERE last_used_at < ?').bind(idle),
    env.DB.prepare(
      'UPDATE users SET bytes_used = ' +
        '(SELECT COALESCE(SUM(bytes), 0) FROM op_files WHERE user_id = users.id) + ' +
        '(SELECT COALESCE(SUM(bytes), 0) FROM blobs WHERE user_id = users.id)',
    ),
  ]);
}

// ---- 入口 -----------------------------------------------------------------

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },

  async fetch(request, env) {
    // 本番(Cloudflare を通った要求)では、手元の試験用の設定を効かせない
    if (clientIp(request)) env = { ...env, DEV_ECHO_OTP: '' };
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    // CORS の下見(preflight)は鍵なしで答える
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // すべての応答(断るときも)に CORS の見出しを付ける。付けないと、ブラウザでは 413・507 などの理由が見えない
    const finish = (res) => {
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      headers.set('cache-control', 'no-store');
      headers.set('strict-transport-security', 'max-age=31536000');
      headers.set('x-content-type-options', 'nosniff');
      headers.set('content-security-policy', "default-src 'none'; sandbox");
      headers.set('referrer-policy', 'no-referrer');
      return new Response(res.body, { status: res.status, headers });
    };

    try {
      if (url.pathname === '/health') return finish(json({ ok: true, version: API_VERSION }));
      if (url.pathname === '/otp/send' && request.method === 'POST') return finish(await handleOtpSend(request, env));
      if (url.pathname === '/otp/verify' && request.method === 'POST') return finish(await handleOtpVerify(request, env));

      const davPath = parseDavPath(url.pathname);

      // ここから先は鍵が要る
      const device = await authenticate(request, env);
      if (!device) {
        // WWW-Authenticate は Bearer にする(Basic にすると、ブラウザがパスワードの入力欄を出すことがある)
        return finish(fail(401, 'ログインが必要です。', { 'www-authenticate': 'Bearer realm="daigaku-note"' }));
      }

      if (davPath) return finish(await handleDav(request, env, device, davPath));
      if (url.pathname === '/me' && request.method === 'GET') return finish(handleMe(env, device));
      if (url.pathname === '/devices' && request.method === 'GET') return finish(await handleDevices(env, device));
      if (url.pathname === '/devices' && request.method === 'DELETE') return finish(await handleDeviceDelete(url, env, device));
      if (url.pathname === '/logout' && request.method === 'POST') {
        await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(device.id).run();
        return finish(json({ ok: true }));
      }
      if (url.pathname === '/account' && request.method === 'DELETE') return finish(await handleDeleteAccount(env, device));
      return finish(fail(404, '見つかりません。'));
    } catch (err) {
      console.log('unhandled', String(err && err.stack || err));
      return finish(fail(500, '処理に失敗しました。'));
    }
  },
};
