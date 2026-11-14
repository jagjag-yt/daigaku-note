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
