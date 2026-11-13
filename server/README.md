# 大学ノートの同期サーバー

メールアドレスに届く6桁の番号でログインするだけで、クラウド同期を使えるようにするためのサーバー。
WebDAV の URL・ユーザー名・アプリパスワードを手で入れなくてよくなる。

- Cloudflare Workers(無料プラン)+ D1(データベース)+ R2(ファイル置き場)+ Resend(メール)
- 住所: `https://note-api.quiz-make.com`
- アプリから見ると `/dav/` は WebDAV のファイル置き場なので、同期の仕組み(`js/webdav.js`)は今のまま使える

## 作り

| ファイル | 中身 |
|---|---|
| `src/index.js` | 入口・ログイン(6桁の番号)・端末の一覧・退会・定期実行 |
| `src/dav.js` | WebDAV のまね(アプリの同期が使う MKCOL・PROPFIND・PUT・GET・HEAD だけ) |
| `src/lib.js` | 小さな道具(ハッシュ・回数制限など) |
| `schema.sql` | D1 の表 |
| `wrangler.jsonc` | デプロイの設定 |

### 受け口

| | | |
|---|---|---|
| `GET /health` | 動いている版 | 鍵なし |
| `POST /otp/send` | `{ email }` → 6桁の番号をメールで送る(10分で切れる) | 鍵なし |
| `POST /otp/verify` | `{ email, code, label }` → `{ token, userId, deviceId, dav, … }`。初めてのアドレスならここで利用者を作る | 鍵なし |
| `GET /me` | メールアドレス・この端末・使っている量(`usage.bytes` / `usage.quota`) | 鍵 |
| `GET /devices` | ログイン中の端末の一覧 | 鍵 |
| `DELETE /devices?id=…` | 端末を1台外す | 鍵 |
| `POST /logout` | この端末を外す | 鍵 |
| `DELETE /account` | 退会(変更・PDF・画像も全部消す) | 鍵 |
| `/dav/…` | 同期の置き場 | 鍵 |

鍵の渡し方は2つ。どちらでも同じ。

- `Authorization: Bearer <token>`
- `Authorization: Basic base64(<ユーザー名>:<token>)` … パスワードに鍵を入れる。ユーザー名は見ない(何でもよい)。
  今のアプリはこちらで送るので、同期の設定に URL `https://note-api.quiz-make.com/dav/`・ユーザー名(何でもよい)・パスワード(鍵)を入れれば、そのまま同期できる。
  アプリは「URL とユーザー名」ごとに同期の進み具合を覚えるので、ユーザー名には利用者ごとに違うもの(`userId` など)を入れるとよい。

### 同期の置き場(`/dav/`)

利用者ごとに `/dav/` が自分だけの置き場になる。置けるのはアプリが使う形だけ(ほかは 403・404)。

| 住所 | 置き場所 |
|---|---|
| `/dav/daigaku-note/ops/<端末ID>/<開始>-<終了>.json` | 変更のファイル。D1 の `op_files` に1ファイル1行(1.9MB まで。超えると 413) |
| `/dav/daigaku-note/ops/<端末ID>/` | D1 の `op_logs` に1行。書くたびに `ver` が増え、それがフォルダの ETag になる |
| `/dav/daigaku-note/files/<sha256>.<拡張子>` | PDF・画像。R2 の `u/<利用者ID>/files/<名前>`(大きさは D1 の `blobs`) |

- アプリは端末のフォルダの ETag が前と同じなら中を見ないので、ふだんの同期は `ops/` の一覧(D1 を1回引く)だけで済む。
- 1人 1GB まで(変更のファイル + PDF・画像)。超える書き込みは 507。アプリは「送れませんでした」と出し、次の同期でもう一度送る。
- PDF・画像1つは 95MB まで(Cloudflare の無料プランの上限が 100MB のため)。超えると 413 で、アプリは変更だけを送る。
- 消す(DELETE)・動かす(MOVE)は受けない(アプリは追記しかしない)。

### 守り

- 6桁の番号と端末の鍵は、`SECRET_PEPPER` を混ぜたハッシュだけを保存する。番号は長さをそろえて比べる。
- 番号は1つにつき5回まで。送信はアドレスごとに1分1回・1日20回、IP ごとに1時間30回。確かめるのも回数を数える。
- 「そのアドレスが登録されているか」は、どの応答からも分からない(利用者を作るのは番号を確かめたとき)。
- 1人5台まで。6台目でログインすると、いちばん長く使っていない端末が外れる。180日使わなかった端末の鍵は切れる。
- 書き込みは1人1時間に1200回まで(D1 の書き込みの無料枠を1人で使い切れないように)。

## はじめに Cloudflare でやること(手作業)

パソコンに Node.js を入れておく。コマンドはこの `server/` フォルダで打つ。

1. **ログイン**

   ```
   npx wrangler login
   ```

2. **D1 のデータベースを作る**

   ```
   npx wrangler d1 create daigaku-note
   ```

   出てきた `database_id` を `wrangler.jsonc` の `REPLACE_WITH_DATABASE_ID` のところに書いて、コミットする。

3. **表を作る**

   ```
   npx wrangler d1 execute daigaku-note --remote --file=schema.sql
   ```

4. **R2 の置き場を作る**(R2 を初めて使うときは、ダッシュボードで R2 を有効にしておく。無料枠の範囲なら料金はかからない)

   ```
   npx wrangler r2 bucket create daigaku-note-files
   ```

5. **秘密の値を入れる**

   ```
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put SECRET_PEPPER
   ```

   - `RESEND_API_KEY`: Resend のダッシュボードで「Sending access」の API キーを作って貼る(quiz-make.com はもう認証済み)。
   - `SECRET_PEPPER`: 長い乱数の文字列。例えば `node -e "console.log(crypto.randomBytes(32).toString('hex'))"` で作る。
     どこにも書き残さなくてよい(変えると全員がログアウトされるだけで、預かったものは消えない)。

   (Worker がまだないと聞かれたら、そのまま作ってよい)

6. **GitHub から自動でデプロイする**

   Cloudflare のダッシュボード → Workers & Pages → 作成 → 「Import a repository」で `daigaku-note` のリポジトリをつなぐ。

   - **Root directory**: `server`
   - Build command: なし(空のまま)
   - Deploy command: `npx wrangler deploy`(はじめから入っている)
   - Production branch: `main`

   これで main に入るたびにデプロイされる。手元から1回だけ出すなら `npx wrangler deploy`。

7. **確かめる**

   ```
   curl https://note-api.quiz-make.com/health
   ```

   `{"ok":true,"version":"…"}` が返ればよい。`version` は `src/index.js` の `API_VERSION`。

## 手元で動かす

```
npx wrangler d1 execute daigaku-note --local --file=schema.sql
npx wrangler dev --var SECRET_PEPPER:testpepper --var RESEND_API_KEY:dummy --var DEV_ECHO_OTP:1 --var OTP_BURST_SECONDS:0
```

`DEV_ECHO_OTP=1` のときは、メールを送らずに番号を応答(`devCode`)に入れる。手元から呼んだときだけ効き、
Cloudflare を通った要求(本番)では設定しても効かない。

テストは、リポジトリの直下で `npm test`(D1 は Node に入っている SQLite で、R2 はメモリで代わりをする。wrangler は要らない)。

- `test/server.test.mjs` … ログイン・端末・CORS・WebDAV のまね・容量・退会
- `test/server-sync.test.mjs` … 本物の `js/webdav.js` を2台ぶん動かし、このサーバーを通して変更と PDF を送り合う

## 無料プランの上限で気をつけること

- D1 は1つのデータベースが 500MB まで(無料プラン)。変更のファイルは D1 に入るので、利用者が増えたら
  使っている量(`SELECT SUM(bytes) FROM op_files`)を見ておく。足りなくなりそうなら、有料プラン(10GB)にするか、変更のファイルも R2 に移す。
- D1 の書き込みは1日10万行、読み取りは1日500万行まで。同期は1分ごとに `ops/` を一覧する(読み取り)。
- Workers は1日10万回まで。1台の端末が開きっぱなしだと、1分ごとの同期で1日に約1,500回。
