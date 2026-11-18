// クーポンコード(テストに協力してくれた人への特典など)。
//
// 方針:
//   ・コードを作れるのは、Cloudflare のアカウントに入れる人(運営者)だけ。発行の受け口はサーバーに作らず、
//     server/scripts/coupon.mjs が D1 に直接書き込む(wrangler d1 execute)。外から発行する道がない。
//   ・1つのコードは1回だけ使える。使った利用者と日時を残す。
//   ・コードそのものは持たず、ハッシュだけを持つ(データベースが漏れても、まだ使っていないコードは使えない)。
//     発行するときに SECRET_PEPPER が要らないよう、ハッシュには決まった前置きだけを混ぜる。
//     コードは 32 種類の文字 × 12 文字(60 ビット)なので、当て推量では当たらない。試す回数にも上限を付ける。
//
// 受け口(src/index.js から呼ぶ。鍵が要る):
//   POST /coupon { code } → { ok, perk, expiresAt, perks }
//   GET  /me の perks に、いま持っている特典が載る

import { allowRate, fail, json, nowIso, readJson } from './lib.js';

/** 特典の種類と、画面に出す名前。足すときはここと、アプリの js/account-ui.js の PERK_NAMES に足す。 */
export const PERKS = {
  adfree: '広告なし',
  pro: 'Pro プラン',
  max: 'Max プラン',
};

/** コードに使う文字。見間違えやすい 0・O・1・I は使わない(32 種類)。 */
export const COUPON_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 12;

/** 新しいコード(XXXX-XXXX-XXXX)。暗号用の乱数で作る。32 は 256 を割り切るので偏りは出ない。 */
export function newCouponCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  const s = [...bytes].map((b) => COUPON_ALPHABET[b % 32]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/**
 * 入力されたコードをそろえる。全角・小文字・空白・ハイフンを許し、見間違えやすい O→0 ではなく
 * 「使わない文字」は間違いとして扱う(形が違えば null)。
 */
export function normalizeCoupon(value) {
  const s = String(value ?? '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角の英数字
    .replace(/[\s\-‐－ー―]/g, '')
    .toUpperCase();
  if (s.length !== CODE_LENGTH) return null;
  for (const c of s) if (!COUPON_ALPHABET.includes(c)) return null;
  return s;
}

/** コードのハッシュ(保存・照合用)。そろえたあとの形から作る。 */
export async function couponHash(normalized) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`daigaku-note-coupon:${normalized}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** いま有効な特典の一覧(期限切れは除く)。 */
export async function activePerks(db, userId) {
  const rows = await db.prepare('SELECT perk, expires_at FROM perks WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY perk')
    .bind(userId, nowIso()).all();
  return rows.results.filter((r) => Object.hasOwn(PERKS, r.perk)).map((r) => ({ perk: r.perk, name: PERKS[r.perk], expiresAt: r.expires_at ?? null }));
}

const BAD = 'このコードは使えません。入力が正しいか、使用済み・期限切れでないかを確かめてください。';

/** コードを使う。1回だけ。ip は呼び出し元の IP(手元の試験では null)。 */
export async function handleCouponRedeem(request, env, device, ip) {
  const body = await readJson(request);
  const raw = String(body?.code ?? '');
  if (!raw.trim()) return fail(400, 'コードを入力してください。');

  // 当て推量を防ぐ。形が違うものも数える
  const okUser = await allowRate(env.DB, `coupon:u:${device.user_id}`, 10, 60 * 60);
  const okIp = !ip || (await allowRate(env.DB, `coupon:ip:${ip}`, 30, 60 * 60));
  if (!okUser || !okIp) return fail(429, 'コードを試す回数が上限に達しました。1時間ほど待ってからお試しください。');

  const code = normalizeCoupon(raw);
  if (!code) return fail(400, 'コードの形が正しくありません。「XXXX-XXXX-XXXX」の12文字です。');
  const hash = await couponHash(code);
  const now = nowIso();

  const row = await env.DB.prepare('SELECT perk, days, expires_at, redeemed_by FROM coupons WHERE code_hash = ?').bind(hash).first();
  if (!row || !Object.hasOwn(PERKS, row.perk)) return fail(400, BAD);
  if (row.redeemed_by === device.user_id) return fail(409, 'このコードは、このアカウントですでに使っています。');
  if (row.redeemed_by || (row.expires_at && row.expires_at <= now)) return fail(400, BAD);

  // 同じ特典をずっと使える状態で持っているなら、コードを使い切らずに知らせる(ほかの人に渡せるように)
  const has = await env.DB.prepare('SELECT expires_at FROM perks WHERE user_id = ? AND perk = ?').bind(device.user_id, row.perk).first();
  if (has && has.expires_at === null) return fail(409, `「${PERKS[row.perk]}」の特典はすでに付いています。このコードは使わずに残しました。`);

  // 使用済みにするのと特典を付けるのを、1つの batch(取り消しの効くまとまり)で行う。
  // 同時に2人が同じコードを送っても、redeemed_by IS NULL の条件で1人だけが通り、もう1人の INSERT は何も書かない
  const [claim] = await env.DB.batch([
    env.DB.prepare(
      'UPDATE coupons SET redeemed_by = ?1, redeemed_at = ?2 WHERE code_hash = ?3 AND redeemed_by IS NULL AND (expires_at IS NULL OR expires_at > ?2) RETURNING perk',
    ).bind(device.user_id, now, hash),
    env.DB.prepare(
      'INSERT INTO perks (user_id, perk, granted_at, expires_at, coupon_hash) ' +
        "SELECT ?1, perk, ?2, CASE WHEN days IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ?2, '+' || days || ' days') END, code_hash " +
        'FROM coupons WHERE code_hash = ?3 AND redeemed_by = ?1 AND redeemed_at = ?2 ' +
        'ON CONFLICT (user_id, perk) DO UPDATE SET granted_at = excluded.granted_at, coupon_hash = excluded.coupon_hash, ' +
        // 期限つきどうしなら、長いほう(残りに足すのではなく、遅いほうの期限)。どちらかが無期限なら無期限
        'expires_at = CASE WHEN perks.expires_at IS NULL OR excluded.expires_at IS NULL THEN NULL ' +
        'WHEN perks.expires_at < ?2 THEN excluded.expires_at ELSE max(perks.expires_at, excluded.expires_at) END',
    ).bind(device.user_id, now, hash),
  ]);
  if (!claim.results?.length) return fail(400, BAD);

  const perks = await activePerks(env.DB, device.user_id);
  const got = perks.find((p) => p.perk === row.perk);
  return json({ ok: true, perk: row.perk, name: PERKS[row.perk], expiresAt: got?.expiresAt ?? null, perks });
}
