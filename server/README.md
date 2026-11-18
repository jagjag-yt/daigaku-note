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
| `src/inactive.js` | 長く使われていないアカウントの片づけ(365日使われていなければお知らせのメール、30日後に削除。Pro・Max は除く。日数は vars の INACTIVE_DAYS で変えられる) |
| `src/dav.js` | WebDAV のまね(アプリの同期が使う MKCOL・PROPFIND・PUT・GET・HEAD だけ) |
| `src/lib.js` | 小さな道具(ハッシュ・回数制限など) |
| `src/coupon.js` | クーポンコード(使う・特典の一覧) |
| `src/plan.js` | プラン(無料・Pro・Max)ごとの容量・端末の数・広告の有無 |
| `scripts/coupon.mjs` | クーポンコードの発行・一覧・停止(運営者のパソコンで使う) |
| `schema.sql` | D1 の表 |
| `wrangler.jsonc` | デプロイの設定 |

### 受け口

| | | |
|---|---|---|
| `GET /health` | 動いている版 | 鍵なし |
| `POST /otp/send` | `{ email, purpose }` → 6桁の番号をメールで送る(10分で切れる)。`purpose` は `login`・`signup` で、メールの件名と本文だけが変わる(登録の有無では変えない) | 鍵なし |
| `POST /otp/verify` | `{ email, code, label, purpose }` → `{ token, userId, deviceId, dav, existing, … }`。`purpose: 'signup'`(またはなし=以前のアプリ)なら初めてのアドレスはここで利用者を作る。`purpose: 'login'` でアカウントがなければ鍵を出さずに 404 `{ reason: 'no_account' }`(番号は使用済みにしないので、同じ番号を `signup` で送り直せば作れる。番号を確かめたあとなので、登録の有無は本人にしか分からない) | 鍵なし |
| `GET /me` | メールアドレス・この端末・使っている量(`usage.bytes` / `usage.quota`) | 鍵 |
| `GET /devices` | ログイン中の端末の一覧 | 鍵 |
| `DELETE /devices?id=…` | 端末を1台外す | 鍵 |
| `POST /logout` | この端末を外す | 鍵 |
| `DELETE /account` | 退会(変更・PDF・画像も全部消す) | 鍵 |
| `POST /coupon` | `{ code }` → クーポンコードを使って特典を付ける。1つのコードは1回だけ。`/me` の `perks` に特典が載る | 鍵 |
| `/dav/…` | 同期の置き場 | 鍵 |

鍵の渡し方は2つ。どちらでも同じ。

- `Authorization: Bearer <token>`
- `Authorization: Basic base64(<ユーザー名>:<token>)` … パスワードに鍵を入れる。ユーザー名は見ない(何でもよい)。
  アプリの同期の仕組み(`js/webdav.js`)はこちらで送る。アプリの「大学ノートアカウントで同期」(`js/account.js`)は、
  ログインで受け取った `dav`・`userId`・`token` を、WebDAV の URL・ユーザー名・パスワードとして設定する。
  (アプリは「URL とユーザー名」ごとに同期の進み具合を覚えるので、ユーザー名を利用者ごとに違う `userId` にしている)

### 同期の置き場(`/dav/`)

利用者ごとに `/dav/` が自分だけの置き場になる。置けるのはアプリが使う形だけ(ほかは 403・404)。

| 住所 | 置き場所 |
|---|---|
| `/dav/daigaku-note/ops/<端末ID>/<開始>-<終了>.json` | 変更のファイル。中身は R2 の `u/<利用者ID>/ops/<端末ID>/<名前>`、目録(大きさ・ETag)は D1 の `op_files` に1行(20MB まで。超えると 413) |
| `/dav/daigaku-note/ops/<端末ID>/` | D1 の `op_logs` に1行。書くたびに `ver` が増え、それがフォルダの ETag になる |
| `/dav/daigaku-note/files/<sha256>.<拡張子>` | PDF・画像。R2 の `u/<利用者ID>/files/<名前>`(大きさは D1 の `blobs`) |

- アプリは端末のフォルダの ETag が前と同じなら中を見ないので、ふだんの同期は `ops/` の一覧(D1 を1回引く)だけで済む。
- 中身はすべて R2 に置き、D1 には目録だけを持つ。変更のファイルは R2 に置き終えてから目録に載せるので、ほかの端末が一覧で見つけたものは必ず読める。
- 1人 1GB まで(変更のファイル + PDF・画像)。超える書き込みは 507。アプリは「送れませんでした」と出し、次の同期でもう一度送る。
- PDF・画像1つは 95MB まで(Cloudflare の無料プランの上限が 100MB のため)。超えると 413 で、アプリは変更だけを送る。
- 消す(DELETE)・動かす(MOVE)は受けない(アプリは追記しかしない)。

### 守り

- 6桁の番号と端末の鍵は、`SECRET_PEPPER` を混ぜたハッシュだけを保存する。番号は長さをそろえて比べる。
- 番号は1つにつき5回まで。送信はアドレスごとに1分1回・1日30回、アドレスと IP の組で1日10回、IP ごとに1時間20回。確かめるのも回数を数える。
  他人が同じアドレスへ送り続けても、別の IP からなら本人はログインできる。
- サービス全体で送る番号のメールは、1日 `OTP_DAILY_LIMIT`(既定 90)通・30日 `OTP_MONTHLY_LIMIT`(既定 2900)通まで。
  Resend の無料枠(1日100通・月3,000通)を使い切って全員がログインできなくなるのを防ぐ。超えると 503 で「この端末だけで使うことはできます」と出る。
  Resend を有料にしたら、`wrangler.jsonc` の `vars` に `"OTP_DAILY_LIMIT": "1500"` のように書いて上げる。
  上限に届くとログに `otp global limit reached` が出るので、Cloudflare のダッシュボードの Workers のログで見張る。
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

   出てきた `database_id` を `wrangler.jsonc` の `database_id` に書いて、コミットする(作った D1 は 2026-11-14 に書き込み済み)。「設定に書き足すか」と聞かれたら n と答える(別の名前で二重に書かれるため)。

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

   schema.sql を変えた変更は、main に入れる前に「3. 表を作る」のコマンドを流しておく(表より先に新しいサーバーが動かないように)。

7. **確かめる**

   ```
   curl https://note-api.quiz-make.com/health
   ```

   `{"ok":true,"version":"…"}` が返ればよい。`version` は `src/index.js` の `API_VERSION`。

## クーポンコードを配る

テストに協力してくれた人への「広告なし」などの特典は、クーポンコードで配る。

- コードを作れるのは、Cloudflare にログインしたパソコン(`npx wrangler login` 済み)だけ。サーバーには発行の受け口がなく、
  `scripts/coupon.mjs` が D1 に直接書き込む。
- 1つのコードは1回だけ使える。使った人はアプリの「アカウント」の「特典」の欄にコードを入れる。
- サーバーにはコードそのものを置かず、ハッシュだけを置く。作ったコードは、作ったときの画面と `server/coupons/` のファイルにしか残らない
  (このフォルダはコミットしない)。なくしたら、作り直して古いものは止める。

コマンドはこの `server/` フォルダで打つ(Windows でも `node` のまま)。

```
node scripts/coupon.mjs make --count 10 --note "テスト協力 2026-11"
```

広告なし(期限なし)のコードを10個作り、画面に出して `coupons/` に保存する。ほかに付けられるもの:

- `--days 365` … 特典を365日だけにする(付けなければ期限なし)
- `--until 2027-03-31` … コードを使える期限(その日の終わり、日本時間)。過ぎたコードは使えない
- `--dry-run` … データベースに書かずに、作る SQL を見るだけ(出たコードは使えない)

```
node scripts/coupon.mjs list                       … 発行した数と使われた数(メモごと)
node scripts/coupon.mjs disable XXXX-XXXX-XXXX     … まだ使われていないコードを使えなくする
```

どれも `--local` を付けると、手元の D1(`wrangler dev` 用)に対して行う。

**はじめて使う前に**、表を足すために schema.sql をもう一度流し、サーバーを配信する(何度流しても壊れない)。
**schema.sql は、この変更を main に入れる前に流す**(手順6の自動デプロイをつないでいると、main に入った時点で新しいサーバーが動くため)。
表がないまま動いても、`/me` の特典が空になり、`/coupon` が失敗するだけで、ログイン・同期・退会は止まらない。

```
npx wrangler d1 execute daigaku-note --remote --file=schema.sql
npx wrangler deploy
```

## 手元で動かす

```
npx wrangler d1 execute daigaku-note --local --file=schema.sql
npx wrangler dev --var SECRET_PEPPER:testpepper --var RESEND_API_KEY:dummy --var DEV_ECHO_OTP:1 --var OTP_BURST_SECONDS:0
```

`DEV_ECHO_OTP=1` のときは、メールを送らずに番号を応答(`devCode`)に入れる。手元から呼んだときだけ効き、
Cloudflare を通った要求(本番)では設定しても効かない。

アプリをこのサーバーにつなぐには、ブラウザの開発者ツールで
`localStorage.setItem('daigaku-note.api', 'http://localhost:8787')` を実行してから開き直す(`npm start` の http://localhost:8123 は CORS で許可してある)。
元に戻すには `localStorage.removeItem('daigaku-note.api')`。

wrangler なしで試すなら `node test/worker-server.mjs 8131`(D1・R2 はメモリ上の代わり。番号は応答の `devCode` に入る)。

テストは、リポジトリの直下で `npm test`(D1 は Node に入っている SQLite で、R2 はメモリで代わりをする。wrangler は要らない)。

- `test/server.test.mjs` … ログイン・端末・CORS・WebDAV のまね・容量・退会
- `test/server-sync.test.mjs` … 本物の `js/webdav.js`・`js/account.js` を2台ぶん動かし、このサーバーを通して変更と PDF を送り合う
- `test/ui/account.spec.js`(`npm run test:ui`)… ログインしないと使えないこと、ログインとアカウント作成のページ、2台で同期・端末を外す・ログアウト・アカウントの削除

## 無料プランの上限で気をつけること

- R2 は保存 10GB・書き込み(PUT など)月100万回・読み取り(GET・HEAD)月1,000万回まで無料。中身(変更のファイル・PDF・画像)はここに入る。
  1人 1GB までなので、全員が上限まで使うと10人で埋まる。実際の使い方は1人数十MB〜数百MBの見込み。
  ダッシュボードの R2 の画面で使っている量を見ておき、10GB に近づいたら上限を下げるか、超えた分を払う(1GB あたり月 0.015 ドル)。
- D1 は1つのデータベースが 500MB まで(無料プラン)。入るのは目録(1ファイル数十バイト)・利用者・端末だけなので、数千人でも収まる。
- D1 の書き込みは1日10万行、読み取りは1日500万行まで。変更のファイル1つで書き込みは3〜4行。同期は1分ごとに `ops/` を一覧する(読み取り)。
- Workers は1日10万回まで。1台の端末が開きっぱなしだと、1分ごとの同期で1日に約1,500回(常に開いている端末が60台ほどで上限)。
