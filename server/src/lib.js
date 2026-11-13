// 小さな道具。外部の依存を増やさず、Workers に元からあるものだけで組む。
// (quizmake の api/src/lib.js から、この API で使うものだけを持ってきた)

/** JSON を返す。 */
export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

/** 失敗を返す。理由は利用者に見せる日本語で持つ。 */
export function fail(status, message, extra = {}) {
  return json({ ok: false, message }, status, extra);
}

/** いまの時刻(ISO8601)。 */
export const nowIso = () => new Date().toISOString();

/** id を作る。用途ごとに接頭辞を付けて、ログで見分けられるようにする。 */
export function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 6桁の数字。Math.random ではなく暗号用の乱数を使う(推測されないため)。偏りが出ないよう、端数の範囲は引き直す */
export function newOtpCode() {
  const max = Math.floor(0x100000000 / 1000000) * 1000000;
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    if (n < max) return String(n % 1000000).padStart(6, '0');
  }
}

/**
 * 秘密の値(6桁の数字・端末の鍵)をハッシュにする。
 * そのまま保存すると、データベースが漏れたときにそのまま使われる。照合できれば十分なので、ハッシュだけを持つ。
 */
export async function hashSecret(value, pepper) {
  if (!pepper) throw new Error('SECRET_PEPPER が設定されていません');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${pepper}:${value}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 長さをそろえて比べる(応答時間の差から中身を推測されないため)。 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** メールアドレスをそろえる。大文字と前後の空白で別人にしない。 */
export const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();

/** 形だけ確かめる。厳密な確かめはメールが届くかどうかに任せる。 */
export const looksLikeEmail = (value) => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/** 端末の名前(利用者が見分けるため)。制御文字を除き、40文字まで。空なら null */
export function normalizeLabel(value) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim();
  return s ? [...s].slice(0, 40).join('') : null;
}

/** 端末の名前を User-Agent からそれらしく作る(アプリが名前を送らなかったとき)。見分けが付けば十分。 */
export function deviceLabel(userAgent) {
  const ua = String(userAgent ?? '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '不明な端末';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'アプリ';
  return `${os} の ${browser}`;
}

/**
 * 使いすぎを止める。数えるのと判定を1つの命令で行う(同時にたくさん来ても、古い数を読んで上限をすり抜けない)。
 * 期限が過ぎていたら1から数え直す。断った分も数える(送り続けても許されない)。
 * @returns {Promise<boolean>} まだ許してよいか
 */
export async function allowRate(db, bucket, limit, windowSec) {
  const now = new Date();
  const row = await db
    .prepare(
      'INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?1, 1, ?2) ' +
        'ON CONFLICT(bucket) DO UPDATE SET ' +
        'count = CASE WHEN rate_limits.reset_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END, ' +
        'reset_at = CASE WHEN rate_limits.reset_at <= ?3 THEN excluded.reset_at ELSE rate_limits.reset_at END ' +
        'RETURNING count',
    )
    .bind(bucket, new Date(now.getTime() + windowSec * 1000).toISOString(), now.toISOString())
    .first();
  return (row?.count ?? 1) <= limit;
}

/** XML の文字を逃がす(PROPFIND の応答の中身に名前を入れるため。属性には使わない)。 */
export const xmlEscape = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);

/**
 * 本文を上限まで読む。上限を超えたら読むのをやめて null(大きな本文でメモリを使い切らないように)。
 * @returns {Promise<Uint8Array|null>}
 */
export async function readLimited(request, max) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/** 送られてきた JSON を読む(小さなものだけ)。壊れている・大きすぎるときは null。 */
export async function readJson(request, max = 16 * 1024) {
  try {
    const buf = await readLimited(request, max);
    return buf ? JSON.parse(new TextDecoder().decode(buf)) : null;
  } catch {
    return null;
  }
}
