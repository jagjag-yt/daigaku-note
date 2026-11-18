#!/usr/bin/env node
// クーポンコードを発行する・一覧を見る・止める(運営者だけが使う道具)。
//
// サーバーに発行の受け口はない。この道具が wrangler で D1 に直接書き込むので、
// Cloudflare のアカウントにログインしている人(npx wrangler login 済みのパソコン)しか発行できない。
//
// 使い方(server フォルダで。Windows は node をそのまま使えばよい):
//   node scripts/coupon.mjs make --count 10 --note "テスト協力 2026-11"
//       広告なし(ずっと)のコードを10個作る。作ったコードは画面に出し、coupons/ フォルダにも保存する
//   node scripts/coupon.mjs make --count 5 --days 365 --until 2027-03-31 --note "…"
//       特典は365日だけ。コードは 2027-03-31 の終わり(日本時間)までに使わないと使えなくなる
//   node scripts/coupon.mjs list
//       発行したコードの一覧(メモ・使ったかどうか)。コードそのものはサーバーにないので出ない
//   node scripts/coupon.mjs disable ABCD-EFGH-JKLM
//       まだ使われていないコードを使えなくする(渡す相手を間違えた・漏れたとき)
//
// 共通: --local を付けると、手元の D1(wrangler dev 用)に対して行う。--dry-run は SQL を出すだけで実行しない。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERKS, couponHash, newCouponCode, normalizeCoupon } from '../src/coupon.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_NAME = 'daigaku-note';

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--local' || a === '--dry-run') opts[a.slice(2)] = true;
    else if (a.startsWith('--')) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) die(`${a} の値がありません。`);
      opts[a.slice(2)] = v;
      i++;
    } else opts._.push(a);
  }
  return { cmd, opts };
}

function die(message) {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * wrangler で SQL を流す。
 *   file … 長い SQL(発行)。ファイルに書いて --file で渡す
 *   それ以外 … 短い SQL を --command で渡し、結果の行(JSON)を返す。SQL には " と % を入れないこと(Windows のコマンドプロンプトを通るため)
 */
function runSql({ sql, local, dryRun, file = false }) {
  if (dryRun) {
    console.log(sql);
    return null;
  }
  const win = process.platform === 'win32';
  let tmp = null;
  const args = ['wrangler', 'd1', 'execute', DB_NAME, local ? '--local' : '--remote', '--yes'];
  if (file) {
    tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dn-coupon-')), 'q.sql');
    fs.writeFileSync(tmp, sql);
    args.push(win ? `--file="${tmp}"` : `--file=${tmp}`);
  } else {
    if (/["%]/.test(sql)) throw new Error('SQL に " や % は使えません');
    args.push('--json', win ? `--command="${sql}"` : `--command=${sql}`);
  }
  // Windows の npx は npx.cmd。.cmd は shell を通さないと動かないので、そのときだけ shell を使う(引数は自分で作ったものだけ)
  const r = spawnSync(win ? 'npx.cmd' : 'npx', args, { cwd: SERVER_DIR, encoding: 'utf8', shell: win, stdio: file ? 'inherit' : ['inherit', 'pipe', 'inherit'] });
  if (tmp) fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  if (r.status !== 0) {
    if (r.stdout) console.error(r.stdout);
    die('wrangler が失敗しました。上のメッセージを確かめてください(npx wrangler login が済んでいるかなど)。');
  }
  if (file) return [];
  try {
    const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
    return out.flatMap((x) => x.results ?? []);
  } catch {
    console.log(r.stdout);
    die('wrangler の結果を読めませんでした。');
  }
}

/** 「2027-03-31」→ その日の終わり(日本時間)の ISO 形式 */
function endOfDayJst(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) die('--until は 2027-03-31 の形で書いてください。');
  const t = Date.parse(`${ymd}T23:59:59.999+09:00`);
  if (Number.isNaN(t)) die('--until の日付が正しくありません。');
  if (t <= Date.now()) die('--until が過去の日付です。');
  return new Date(t).toISOString();
}

async function make(opts) {
  const count = Number(opts.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 500) die('--count は 1〜500 の整数にしてください。');
  const perk = opts.perk ?? 'adfree';
  if (!PERKS[perk]) die(`--perk は ${Object.keys(PERKS).join('・')} のどれかです。`);
  let days = null;
  if (opts.days !== undefined) {
    days = Number(opts.days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) die('--days は 1〜3650 の整数にしてください。');
  }
  const until = opts.until ? endOfDayJst(opts.until) : null;
  const note = String(opts.note ?? '').slice(0, 100);
  const now = new Date().toISOString();

  const codes = [];
  const seen = new Set();
  while (codes.length < count) {
    const code = newCouponCode();
    if (!seen.has(code)) { seen.add(code); codes.push(code); }
  }
  const rows = await Promise.all(codes.map(async (c) => {
    const h = await couponHash(normalizeCoupon(c));
    return `(${sqlText(h)}, ${sqlText(perk)}, ${days ?? 'NULL'}, ${until ? sqlText(until) : 'NULL'}, ${sqlText(note)}, ${sqlText(now)})`;
  }));
  const sql = `INSERT INTO coupons (code_hash, perk, days, expires_at, note, created_at) VALUES\n${rows.join(',\n')};\n`;

  if (runSql({ sql, local: opts.local, dryRun: opts['dry-run'], file: true }) === null) {
    console.log('\n(--dry-run なので、データベースには書いていません。下のコードは使えません)');
  }
  const what = `${PERKS[perk]}(${days ? `${days}日` : 'ずっと'})`;
  const header = [
    `大学ノート クーポンコード ${count}個`,
    `特典: ${what}`,
    `コードを使える期限: ${opts.until ? `${opts.until} まで` : 'なし'}`,
    `メモ: ${note || 'なし'}`,
    `発行: ${now}${opts.local ? '(手元のデータベース)' : ''}${opts['dry-run'] ? '(試しに出しただけ・未登録)' : ''}`,
    '',
  ];
  const text = [...header, ...codes, ''].join('\n');
  console.log(`\n${text}`);
  if (!opts['dry-run']) {
    const dir = path.join(SERVER_DIR, 'coupons');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${now.replace(/[:.]/g, '-')}${opts.local ? '-local' : ''}.txt`);
    fs.writeFileSync(file, text);
    console.log(`保存しました: ${file}`);
    console.log('このファイルはコミットしないでください(.gitignore に入れてあります)。使い道を書き足してもかまいません。');
  }
}

function list(opts) {
  const sql = 'SELECT note, perk, days, created_at, expires_at, COUNT(*) AS issued, COUNT(redeemed_at) AS used ' +
    'FROM coupons GROUP BY note, perk, days, created_at, expires_at ORDER BY created_at DESC';
  const rows = runSql({ sql, local: opts.local, dryRun: opts['dry-run'] });
  if (!rows) return;
  if (!rows.length) { console.log('発行したコードはまだありません。'); return; }
  const jst = (iso) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
  console.table(rows.map((r) => ({
    発行日: jst(r.created_at),
    メモ: r.note || '',
    特典: `${PERKS[r.perk] ?? r.perk}(${r.days ? `${r.days}日` : 'ずっと'})`,
    使える期限: r.expires_at ? (Date.parse(r.expires_at) < Date.now() ? '切れた・止めた' : `${jst(r.expires_at)} まで`) : 'なし',
    発行数: r.issued,
    使用済み: r.used,
  })));
}

async function disable(opts) {
  const code = normalizeCoupon(opts._[0]);
  if (!code) die('止めるコードを「XXXX-XXXX-XXXX」の形で指定してください。');
  const h = await couponHash(code);
  // 使えなくするには、使える期限を過去にする(行は残すので、同じコードが二度と使われない)
  const rows = runSql({
    sql: `UPDATE coupons SET expires_at = '2000-01-01T00:00:00.000Z' WHERE code_hash = ${sqlText(h)} AND redeemed_by IS NULL RETURNING code_hash`,
    local: opts.local,
    dryRun: opts['dry-run'],
  });
  if (!rows) return;
  if (rows.length) { console.log('止めました。このコードはもう使えません。'); return; }
  const found = runSql({ sql: `SELECT redeemed_at FROM coupons WHERE code_hash = ${sqlText(h)}`, local: opts.local });
  if (!found.length) console.log('そのコードは見つかりませんでした(打ち間違い・別のデータベースかもしれません)。');
  else console.log(`そのコードは ${found[0].redeemed_at} にすでに使われていました。付いた特典は残っています。`);
}

const { cmd, opts } = parseArgs(process.argv.slice(2));
if (cmd === 'make') await make(opts);
else if (cmd === 'list') list(opts);
else if (cmd === 'disable') await disable(opts);
else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(cmd ? 1 : 0);
}
