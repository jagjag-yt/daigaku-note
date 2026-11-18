// プラン(無料・Pro・Max)。容量と、ログインできる端末の数と、広告を出すかを決める。
//
// プランは特典(perks の表)で決める。Pro・Max はストアの定期購入で付ける予定で、今はクーポンコード
// (scripts/coupon.mjs make --perk pro --days 30 など)でも付けられる。両方あれば Max。
// 価格(2026-11 に決めたもの): Pro 月250円・年2,400円、Max 月600円・年6,000円。広告なしの買い切りは600円。
//
// 特典の表がまだない(schema.sql を流す前に配信した)ときは無料として扱う。
// それ以外の読み込みの失敗(一時的な D1 の障害など)は投げる。無料として扱うと、Pro の人の端末を外したり、
// 容量の上限で書き込みを断ったりしてしまうため。

const GB = 1024 * 1024 * 1024;

export const PLANS = {
  free: { id: 'free', name: '無料', quota: 1 * GB, devices: 5, adFree: false },
  pro: { id: 'pro', name: 'Pro', quota: 30 * GB, devices: 10, adFree: true },
  max: { id: 'max', name: 'Max', quota: 200 * GB, devices: 10, adFree: true },
};

/** 特典の一覧(activePerks の戻り値)からプランを決める */
export function planFromPerks(perks, env = {}) {
  const has = (p) => perks.some((x) => x.perk === p);
  const base = has('max') ? PLANS.max : has('pro') ? PLANS.pro : PLANS.free;
  // 無料の容量だけは設定で変えられる(手元の試験など。wrangler.jsonc の vars の QUOTA_BYTES)
  const quota = base.id === 'free' ? Number(env.QUOTA_BYTES) || base.quota : base.quota;
  return { ...base, quota, adFree: base.adFree || has('adfree') };
}

/** 利用者のいまのプラン。特典の表がまだなければ無料。ほかの失敗は投げる */
export async function userPlan(env, userId) {
  try {
    const rows = await env.DB.prepare(
      "SELECT perk FROM perks WHERE user_id = ? AND perk IN ('pro', 'max', 'adfree') AND (expires_at IS NULL OR expires_at > ?)",
    ).bind(userId, new Date().toISOString()).all();
    return planFromPerks(rows.results, env);
  } catch (err) {
    if (/no such table/i.test(String(err))) return planFromPerks([], env);
    throw err;
  }
}
