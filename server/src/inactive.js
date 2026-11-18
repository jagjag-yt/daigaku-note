// 長いあいだ使われていないアカウントの片づけ(週1回の定期実行から呼ぶ)。
//
//   1. 最後に使った日(users.last_seen_at)から INACTIVE_DAYS 日(既定 365日)たった人に、お知らせのメールを送る
//   2. お知らせから NOTICE_DAYS 日(30日)たっても使われていなければ、アカウントとノートを消す
//
// お知らせのあとに一度でも同期・ログインすれば取り消される(src/index.js の authenticate とログイン)。
// お金を払った人(Pro・Max・広告なしの買い切り。クーポンで付いたものも含む。期限内のもの)は片づけない。メールはログインの番号と同じ Resend の枠を使うので、1回に送る数を絞る。

export const NOTICE_DAYS = 30;
const PER_RUN = 20;

const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

// 期限内の Pro・Max・広告なしを持っている人を除く条件
const NOT_PAID =
  "NOT EXISTS (SELECT 1 FROM perks p WHERE p.user_id = u.id AND p.perk IN ('pro', 'max', 'adfree') AND (p.expires_at IS NULL OR p.expires_at > ?))";

export function noticeMail(days, deleteOn) {
  return {
    subject: '大学ノート: しばらく使われていないアカウントの削除のお知らせ',
    text:
      `大学ノートのアカウントが、${days}日以上使われていません。\n\n` +
      `${deleteOn} 以降に、このアカウントと、同期のために預かっているノート・PDF・画像を削除します。\n` +
      'アカウントを残す場合は、それまでに大学ノートでログインするか、同期をしてください。\n\n' +
      '端末に保存されているノートは消えません。\n' +
      'このメールに心当たりがない場合は、何もしなくてかまいません。\n',
  };
}

/**
 * 片づけを1回分進める。戻り値は { noticed, purged }(数)。
 * sendMail(email, subject, text) → { ok }、purge(userId, email) → 消せたら true
 */
export async function sweepInactive(env, { sendMail, purge }) {
  const v = Number(env.INACTIVE_DAYS);
  const days = Number.isFinite(v) && v >= 90 ? v : 365; // 設定の間違いで、使っている人にまでお知らせを送らないよう 90日より短くはしない
  const now = new Date().toISOString();
  let noticed = 0;
  let purged = 0;

  // 2. 先に、お知らせ済みで期限が来た人を消す。メールに書いた日(お知らせの30日後)の翌日より前には消さない
  const due = await env.DB.prepare(
    `SELECT u.id, u.email, n.sent_at FROM users u JOIN inactive_notices n ON n.user_id = u.id
     WHERE n.sent_at < ? AND u.last_seen_at <= n.sent_at AND ${NOT_PAID} LIMIT ?`,
  ).bind(daysAgo(NOTICE_DAYS + 1), now, PER_RUN).all();
  for (const u of due.results) {
    // 選んだあとに使われていないかを、消す直前に確かめる(お知らせの記録を消せた1回だけが消しに進む)
    const claimed = await env.DB.prepare(
      'DELETE FROM inactive_notices WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND last_seen_at <= ?) RETURNING user_id',
    ).bind(u.id, u.id, u.sent_at).all();
    if (!claimed.results.length) continue;
    if (await purge(u.id, u.email, u.sent_at)) purged++;
    // 途中で失敗したら、お知らせの記録を戻す(次の回に続きから消す。お知らせを送り直して30日待ち直さない)
    else await env.DB.prepare('INSERT INTO inactive_notices (user_id, sent_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING').bind(u.id, u.sent_at).run().catch(() => {});
  }

  // お知らせのあとに使われた人の記録は消す(次にまた長く空いたら、もう一度お知らせする)
  await env.DB.prepare(
    'DELETE FROM inactive_notices WHERE user_id IN (SELECT u.id FROM users u JOIN inactive_notices n ON n.user_id = u.id WHERE u.last_seen_at > n.sent_at)',
  ).run();

  // 1. お知らせ
  const idle = await env.DB.prepare(
    `SELECT u.id, u.email FROM users u
     WHERE u.last_seen_at < ? AND NOT EXISTS (SELECT 1 FROM inactive_notices n WHERE n.user_id = u.id) AND ${NOT_PAID}
     ORDER BY u.last_seen_at LIMIT ?`,
  ).bind(daysAgo(days), now, PER_RUN).all();
  // 日付は日本時間。消すのはお知らせの31日後より後(この日の翌日以降)なので、書く日付までは消さない
  const deleteOn = new Date(Date.now() + NOTICE_DAYS * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10);
  const mail = noticeMail(days, deleteOn);
  for (const u of idle.results) {
    // 送れなかった人は記録しない(次の回にもう一度送る)。お知らせなしには消さない
    const sent = await sendMail(u.email, mail.subject, mail.text);
    if (!sent?.ok) break; // Resend の枠が尽きたなど。続けても無駄なので止める
    await env.DB.prepare('INSERT INTO inactive_notices (user_id, sent_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING').bind(u.id, now).run();
    noticed++;
  }
  return { noticed, purged };
}
