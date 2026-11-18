-- 大学ノートの同期サーバーのデータベース(Cloudflare D1 / SQLite)
--
-- 流し方(はじめの1回。何度流しても壊れない):
--   npx wrangler d1 execute daigaku-note --remote --file=schema.sql
--
-- 方針:
--   ・アプリから見ると、このサーバーは WebDAV の「ただのファイル置き場」(js/webdav.js がそのまま使える)。
--   ・中身(変更のファイル・PDF・画像)はすべて R2 に置く。ここには目録(名前・大きさ・ETag)だけを持つ。
--     D1 は無料プランだと1つのデータベースが 500MB までなので、中身を入れると数十人で埋まるため。
--   ・メールアドレスは、探すために必要なので平文で持つ。それ以外の個人情報は持たない。
--   ・秘密(6桁の数字・端末の鍵)はハッシュだけを持つ。

-- 利用者。メールアドレス1つにつき1行。
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,          -- u_xxxxx
  email        TEXT NOT NULL UNIQUE,      -- 小文字にそろえて保存する
  created_at   TEXT NOT NULL,             -- ISO8601
  last_seen_at TEXT NOT NULL,
  bytes_used   INTEGER NOT NULL DEFAULT 0, -- 使っている量(変更のファイル + PDF・画像)。上限を超える書き込みは断る
  ver          INTEGER NOT NULL DEFAULT 0, -- 書き込みのたびに1つ増やす。上のフォルダ(ops/ など)の ETag に使う
  write_id     TEXT                        -- 書き込みの合言葉。容量の確保と blobs の行の書き込みを1つの batch で行うため(src/dav.js)
);

-- ログイン用の6桁の数字。使い捨て。数字そのものは持たず、ハッシュだけ。5回間違えたら使えなくなる。
CREATE TABLE IF NOT EXISTS otp_requests (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,              -- 発行から10分
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,                       -- 使ったら入る。二重に使えない
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_requests (email, created_at);

-- ログイン済みの端末(アプリを入れた端末・ブラウザ)。1人5台まで。鍵そのものは持たず、ハッシュだけ。
-- (アプリの「端末ID」= 変更のフォルダの名前とは別のもの。そちらは op_logs.device)
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,         -- d_xxxxx
  user_id       TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,            -- 「iPad の Safari」程度。利用者が見分けるため
  created_at    TEXT NOT NULL,
  last_used_at  TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices (user_id, last_used_at);

-- 変更のフォルダ(daigaku-note/ops/<端末ID>/)。利用者 × アプリの端末ID ごとに1行。
-- ver はこのフォルダにファイルを書くたびに1つ増やし、フォルダの ETag にする(中身が変わると ETag が変わる)。
-- アプリは ETag が前と同じフォルダの中を見ないので、ops/ の一覧はこの表を1回引くだけで済む。
CREATE TABLE IF NOT EXISTS op_logs (
  user_id     TEXT NOT NULL,
  device      TEXT NOT NULL,              -- アプリの端末ID(英数字・- _ の64文字まで)
  ver         INTEGER NOT NULL DEFAULT 0,
  latest_end  INTEGER NOT NULL DEFAULT 0, -- このフォルダのファイルの終了番号のいちばん大きいもの
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, device),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- 変更のファイル(daigaku-note/ops/<端末ID>/<開始番号>-<終了番号>.json)の目録。1ファイル1行。
-- 中身は R2 の u/<利用者>/ops/<端末ID>/<名前>。R2 に置き終えてからこの行を書く(一覧に見えたものは必ず読める)。
CREATE TABLE IF NOT EXISTS op_files (
  user_id     TEXT NOT NULL,
  device      TEXT NOT NULL,
  from_n      INTEGER NOT NULL,
  to_n        INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,           -- 中身のバイト数
  etag        TEXT NOT NULL,              -- R2 が付けた ETag(一覧の getetag に返す)
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, device, from_n, to_n),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- PDF・画像(daigaku-note/files/<sha256>.<拡張子>)。中身は R2 の u/<利用者>/files/<名前>。ここには大きさだけ。
CREATE TABLE IF NOT EXISTS blobs (
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,              -- <sha256>.pdf など
  bytes       INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, name),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- 送りすぎ・試しすぎを止めるための記録。「誰が」「何を」「いつ」やったかだけを数える。
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT PRIMARY KEY,            -- 例: otp:send:someone@example.com
  count      INTEGER NOT NULL,
  reset_at   TEXT NOT NULL
);

-- クーポンコード(テストに協力してくれた人への特典など)。発行は scripts/coupon.mjs だけ(サーバーに発行の受け口はない)。
-- コードそのものは持たず、ハッシュだけ(src/coupon.js の couponHash)。1つのコードは1回だけ使える。
CREATE TABLE IF NOT EXISTS coupons (
  code_hash   TEXT PRIMARY KEY,
  perk        TEXT NOT NULL,              -- 付ける特典。'adfree'(広告なし)・'pro'・'max'
  days        INTEGER,                    -- 特典の日数。NULL ならずっと
  expires_at  TEXT,                       -- このコードを使える期限。NULL なら期限なし
  note        TEXT NOT NULL DEFAULT '',   -- 発行したときのメモ(「テスト協力 2026-11」など)。利用者には見せない
  created_at  TEXT NOT NULL,
  redeemed_by TEXT,                       -- 使った利用者(users.id)。退会したら 'deleted' にする(NULL に戻すと、もう一度使えてしまうため)
  redeemed_at TEXT
);

-- 利用者が持っている特典。特典1種類につき1行。
CREATE TABLE IF NOT EXISTS perks (
  user_id     TEXT NOT NULL,
  perk        TEXT NOT NULL,
  granted_at  TEXT NOT NULL,
  expires_at  TEXT,                       -- NULL ならずっと
  coupon_hash TEXT,                       -- どのコードで付いたか
  PRIMARY KEY (user_id, perk),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- 長いあいだ使われていないアカウントに、削除のお知らせを送った記録(src/inactive.js)。使われたら消す。
CREATE TABLE IF NOT EXISTS inactive_notices (
  user_id TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL,
  purging INTEGER NOT NULL DEFAULT 0,   -- 1 = 消している途中で失敗した(次の回に、使われたかどうかに関係なく続きから消す)
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Apple・Google でのログインのつながり(src/oauth.js)。Apple・Google の中での本人の ID(sub)ごとに1行。
-- メールアドレスが変わっても、同じ Apple・Google のアカウントなら同じ利用者にする。
CREATE TABLE IF NOT EXISTS identities (
  provider   TEXT NOT NULL,               -- 'apple' | 'google'
  subject    TEXT NOT NULL,               -- Apple・Google の ID トークンの sub
  user_id    TEXT NOT NULL,
  email      TEXT,                        -- つないだときのアドレス(Apple の「メールを非公開」なら、Apple が作った転送用のアドレス)
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities (user_id);

-- Apple・Google でのログインの途中の記録(src/oauth.js)。15分で切れる。週1回の掃除で消す。
--   始めたとき: state(Apple・Google に渡す合言葉)・challenge(アプリの合言葉のハッシュ)・戻り先・nonce
--   戻ってきたとき: state の行を消し、引換券(ticket_hash)の行を作る。引換券は5分・1回だけ
CREATE TABLE IF NOT EXISTS oauth_flows (
  state       TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  challenge   TEXT NOT NULL,
  return_to   TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  ticket_hash TEXT UNIQUE,                -- 引換券のハッシュ(戻ってきたあとの行だけ)
  user_id     TEXT,
  existing    INTEGER
);
