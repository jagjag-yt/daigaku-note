// メールを1通送る(ログインの番号・長く使われていないアカウントのお知らせ)。
//
// 送り先のサービスは2つから選ぶ:
//   Amazon SES … 本番の既定。秘密の値 AWS_ACCESS_KEY_ID・AWS_SECRET_ACCESS_KEY を入れると使う。
//                地域は SES_REGION(既定は東京 ap-northeast-1)。1,000通で0.1ドル。
//   Resend     … 以前の送り先。AWS の鍵がなく RESEND_API_KEY があるときに使う(無料は1日100通・月3,000通まで)。
// vars の MAIL_PROVIDER に 'ses' か 'resend' を書くと、どちらかに決められる(切り替えて戻すときのため)。
//
// SES は AWS の署名(Signature Version 4)が要る。Workers には AWS の部品がないので、ここで Web Crypto だけで作る
// (署名は test/oauth.test.mjs で、AWS が配っている Python の部品 botocore と同じになることを確かめた値と比べている)。
// SES_CONFIGURATION_SET(vars)を書くと、その設定セットで送る(届かなかった・迷惑メールにされた数を SES の画面で見るため。任意)。

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmac(key, s) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(s));
}

/** どちらで送るか: 'ses' | 'resend' */
export function mailProvider(env) {
  if (env.MAIL_PROVIDER === 'ses' || env.MAIL_PROVIDER === 'resend') return env.MAIL_PROVIDER;
  return env.AWS_ACCESS_KEY_ID ? 'ses' : 'resend';
}

/**
 * 1日・1か月に送るメールの上限の既定値(送り先のサービスの枠に合わせる)。vars の OTP_DAILY_LIMIT・OTP_MONTHLY_LIMIT で変えられる。
 *   Resend 無料: 1日100通・月3,000通 → 少し下の 90・2,900
 *   SES: 本番の枠は1日5万通からなので枠では止まらない。代わりに、いたずらで大量に送らされたときの料金と、
 *        届かないアドレスへ送りすぎて SES に止められるのを防ぐ線にする(1日2,000通・月3万通 = 月3ドルまで)
 */
export function mailLimitDefaults(env) {
  return mailProvider(env) === 'ses' ? { day: 2000, month: 30000 } : { day: 90, month: 2900 };
}

/**
 * 「大学ノート <no-reply@example.com>」の名前の部分を、日本語のままでも SES が受け取れる形(RFC 2047)にする。
 * SES は送り元の名前に ASCII 以外の文字があると断るため。
 */
export function encodeFrom(from) {
  const m = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/.exec(String(from ?? ''));
  if (!m) return String(from ?? '').trim();
  const [, name, addr] = m;
  if (!name) return addr;
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(name)) return `"${name.replace(/["\\]/g, '\\$&')}" <${addr}>`;
  // 1つの encoded-word は75文字まで(RFC 2047)。文字の途中で切らないよう、45バイトまでずつに分ける
  const words = [];
  let cur = [];
  for (const ch of name) {
    const bytes = [...enc.encode(ch)];
    if (cur.length + bytes.length > 45) { words.push(cur); cur = []; }
    cur.push(...bytes);
  }
  if (cur.length) words.push(cur);
  return `${words.map((w) => `=?UTF-8?B?${btoa(String.fromCharCode(...w))}?=`).join(' ')} <${addr}>`;
}

/**
 * AWS の署名(Signature Version 4)を付けた見出しを作る。
 * host・path は送り先、date は署名の時刻(試験で決まった値を使うため)。
 * 返す見出しには host を含めない(fetch は host を自分で付ける。署名には同じ値を入れてある)。
 */
export async function signAws({ method, host, path, region, service, body, accessKeyId, secretAccessKey, sessionToken, date = new Date() }) {
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261118T160000Z
  const day = amzDate.slice(0, 8);
  const headers = { 'content-type': 'application/json', host, 'x-amz-date': amzDate };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;
  const names = Object.keys(headers).sort();
  const canonical = [
    method,
    path,
    '', // 問い合わせの文字列(なし)
    ...names.map((n) => `${n}:${headers[n]}`),
    '',
    names.join(';'),
    await sha256Hex(body),
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonical)].join('\n');
  let key = await hmac(`AWS4${secretAccessKey}`, day);
  key = await hmac(key, region);
  key = await hmac(key, service);
  key = await hmac(key, 'aws4_request');
  const signature = hex(await hmac(key, toSign));
  const out = { ...headers };
  delete out.host;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return out;
}

/** SES(v2 の SendEmail)で送る */
async function sendSes(env, to, subject, text) {
  const region = env.SES_REGION || 'ap-northeast-1';
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error('SES_REGION の形が正しくありません');
  const host = `email.${region}.amazonaws.com`;
  const path = '/v2/email/outbound-emails';
  const body = JSON.stringify({
    FromEmailAddress: encodeFrom(env.MAIL_FROM),
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Text: { Data: text, Charset: 'UTF-8' } },
      },
    },
    ...(env.SES_CONFIGURATION_SET ? { ConfigurationSetName: env.SES_CONFIGURATION_SET } : {}),
  });
  const headers = await signAws({
    method: 'POST', host, path, region, service: 'ses', body,
    accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  });
  return fetch(`https://${host}${path}`, { method: 'POST', headers, body });
}

/** Resend で送る */
function sendResend(env, to, subject, text) {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
  });
}

/** メールを1通送る。送れたら { ok: true } */
export async function sendMail(env, to, subject, text) {
  const provider = mailProvider(env);
  try {
    const res = provider === 'ses' ? await sendSes(env, to, subject, text) : await sendResend(env, to, subject, text);
    if (!res.ok) {
      // 宛先は出さない(ログに個人のアドレスを残さない)
      console.log(`${provider} failed`, res.status, (await res.text()).slice(0, 500).replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, '***'));
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.log(`${provider} error`, String(err));
    return { ok: false };
  }
}
