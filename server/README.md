# かきためノートの同期サーバー

メールアドレスに届く6桁の番号、または Apple・Google のアカウントでログインするだけで、クラウド同期を使えるようにするためのサーバー。
WebDAV の URL・ユーザー名・アプリパスワードを手で入れなくてよくなる。

<<<<<<< HEAD
- Cloudflare Workers(無料プラン)+ D1(データベース)+ R2(ファイル置き場)+ Amazon SES(メール。鍵を入れるまでは Resend)
- 住所: `https://note-api.quiz-make.com`
=======
- Cloudflare Workers(無料プラン)+ D1(データベース)+ R2(ファイル置き場)+ Resend(メール)
- URL: `https://note-api.quiz-make.com`
>>>>>>> origin/main
- アプリから見ると `/dav/` は WebDAV のファイル置き場なので、同期の仕組み(`js/webdav.js`)は今のまま使える

## ファイル構成

| ファイル | 中身 |
|---|---|
| `src/index.js` | エントリーポイント・ログイン(6桁の番号)・端末の一覧・退会・定期実行 |
| `src/inactive.js` | 長く使われていないアカウントの片づけ(365日使われていなければお知らせのメール、30日後に削除。Pro・Max は除く。日数は vars の INACTIVE_DAYS で変えられる) |
| `src/dav.js` | WebDAV のまね(アプリの同期が使う MKCOL・PROPFIND・PUT・GET・HEAD だけ) |
| `src/lib.js` | 小さな道具(ハッシュ・回数制限など) |
| `src/coupon.js` | クーポンコード(使う・特典の一覧) |
| `src/plan.js` | プラン(無料・Pro・Max)ごとの容量・端末の数・広告の有無 |
| `scripts/coupon.mjs` | クーポンコードの発行・一覧・停止(運営者のパソコンで使う) |
| `schema.sql` | D1 の表 |
| `wrangler.jsonc` | デプロイの設定 |

### API

| | | |
|---|---|---|
| `GET /health` | 動いているバージョン | トークンなし |
| `POST /otp/send` | `{ email, purpose }` → 6桁の番号をメールで送る(10分で切れる)。`purpose` は `login`・`signup` で、メールの件名と本文だけが変わる(登録の有無では変えない) | トークンなし |
| `POST /otp/verify` | `{ email, code, label, purpose }` → `{ token, userId, deviceId, dav, existing, … }`。`purpose: 'signup'`(またはなし=以前のアプリ)なら初めてのアドレスはここで利用者を作る。`purpose: 'login'` でアカウントがなければトークンを出さずに 404 `{ reason: 'no_account' }`(番号は使用済みにしないので、同じ番号を `signup` で送り直せば作れる。番号を確かめたあとなので、登録の有無は本人にしか分からない) | トークンなし |
| `GET /me` | メールアドレス・この端末・使っている量(`usage.bytes` / `usage.quota`) | トークン |
| `GET /devices` | ログイン中の端末の一覧 | トークン |
| `DELETE /devices?id=…` | 端末を1台外す | トークン |
| `POST /logout` | この端末を外す | トークン |
| `DELETE /account` | 退会(変更・PDF・画像も全部消す) | トークン |
| `POST /coupon` | `{ code }` → クーポンコードを使って特典を付ける。1つのコードは1回だけ。`/me` の `perks` に特典が載る | トークン |
| `/dav/…` | 同期の置き場 | トークン |

トークンの渡し方は2つ。どちらでも同じ。

- `Authorization: Bearer <token>`
- `Authorization: Basic base64(<ユーザー名>:<token>)` … パスワードにトークンを入れる。ユーザー名は見ない(何でもよい)。
  アプリの同期の仕組み(`js/webdav.js`)はこちらで送る。アプリの「かきためノートアカウントで同期」(`js/account.js`)は、
  ログインで受け取った `dav`・`userId`・`token` を、WebDAV の URL・ユーザー名・パスワードとして設定する。
  (アプリは「URL とユーザー名」ごとに同期の進み具合を記録するので、ユーザー名を利用者ごとに違う `userId` にしている)

### 同期の置き場(`/dav/`)

利用者ごとに `/dav/` が自分だけの置き場になる。置けるのはアプリが使う形だけ(ほかは 403・404)。

| パス | 置き場所 |
|---|---|
| `/dav/daigaku-note/ops/<端末ID>/<開始>-<終了>.json` | 変更のファイル。中身は R2 の `u/<利用者ID>/ops/<端末ID>/<名前>`、目録(大きさ・ETag)は D1 の `op_files` に1行(20MB まで。超えると 413) |
| `/dav/daigaku-note/ops/<端末ID>/` | D1 の `op_logs` に1行。書くたびに `ver` が増え、それがフォルダの ETag になる |
| `/dav/daigaku-note/files/<sha256>.<拡張子>` | PDF・画像。R2 の `u/<利用者ID>/files/<名前>`(大きさは D1 の `blobs`) |

- アプリは端末のフォルダの ETag が前と同じなら中を見ないので、ふだんの同期は `ops/` の一覧(D1 を1回引く)だけで済む。
- 中身はすべて R2 に置き、D1 には目録だけを持つ。変更のファイルは R2 に置き終えてから目録に載せるので、ほかの端末が一覧で見つけたものは必ず読める。
- 1人 1GB まで(変更のファイル + PDF・画像)。超える書き込みは 507。アプリは「送れませんでした」と出し、次の同期でもう一度送る。
- PDF・画像1つは 95MB まで(Cloudflare の無料プランの上限が 100MB のため)。超えると 413 で、アプリは変更だけを送る。
- 消す(DELETE)・動かす(MOVE)は受けない(アプリは追記しかしない)。

### セキュリティ

<<<<<<< HEAD
- 6桁の番号と端末の鍵は、`SECRET_PEPPER` を混ぜたハッシュだけを保存する。番号は長さをそろえて比べる。
- 番号は1つにつき5回まで。送信は、アドレスと IP の組ごとに1分1回・1日10回、アドレスごとに1日30回(ただし、その IP からそのアドレスへの1日の最初の2通は数えない。数えない分はアドレスごとに1日10通まで)、IP ごとに1日はサービス全体の1日の枠の3割で多くても100回(IPv6 は /64 ごとにまとめ、/48 でも45%・150回まで)。断った送信は、そのあとに調べる上限には数えない(順番は 続けての送信・組 → IP → アドレス → 全体)。確かめるのも回数を数える。
=======
- 6桁の番号と端末のトークンは、`SECRET_PEPPER` を混ぜたハッシュだけを保存する。番号は長さをそろえて比べる。
- 番号は1つにつき5回まで。送信は、アドレスと IP の組ごとに1分1回・1日10回、アドレスごとに1日30回(ただし、その IP からそのアドレスへの1日の最初の2通は数えない。数えない分はアドレスごとに1日10通まで)、IP ごとに1日はサービス全体の1日の枠の3割(既定で27回。IPv6 は /64 ごとにまとめ、/48 でも45%まで)。断った送信は、そのあとに調べる上限には数えない(順番は 続けての送信・組 → IP → アドレス → 全体)。確かめるのも回数を数える。
>>>>>>> origin/main
  他人が同じアドレスへ送り続けても、4つまでの IP からなら、本人は自分の IP から番号を受け取れる。5つ以上の IP から送り続けられると、本人もその日は受け取れなくなる。また、使えるのは最後に送った番号だけなので、送り続けられている間は届いた番号がすぐ使えなくなることがある。これらは Turnstile などで機械からの送信を止めて防ぐ(未対応)。
- サービス全体で送るメール(番号と、長く使われていないアカウントへのお知らせの合計)は、暦の1日(UTC)に `OTP_DAILY_LIMIT` 通・暦の1か月に `OTP_MONTHLY_LIMIT` 通まで。お知らせはその半分までしか使わない。
  既定は SES なら1日2,000通・月3万通(いたずらで大量に送らされても月3ドルまで)、Resend なら無料枠の少し下の1日90通・月2,900通。超えると 503 で「この端末だけで使うことはできます」と出る。
  変えるときは `wrangler.jsonc` の `vars` に `"OTP_DAILY_LIMIT": "5000"` のように書く。
  多くの IP から送られると、全体の枠を使い切られる・届かないアドレスへ送らされて SES に止められるおそれがある。
  利用者が増えたら、Turnstile などで機械からの送信を止める(未対応)。
  上限に届くとログに `otp global limit reached` が出るので、Cloudflare のダッシュボードの Workers のログで見張る。
- 「そのアドレスが登録されているか」は、どの応答からも分からない(利用者を作るのは番号を確かめたとき)。
- 1人5台まで。6台目でログインすると、いちばん長く使っていない端末が外れる。180日使わなかった端末のトークンは失効する。
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
     Amazon SES に切り替えたら要らない(下の「メールを Amazon SES で送る」)。
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

## メールを Amazon SES で送る

Resend の無料枠(1日100通)では足りないので、ログインの番号は Amazon SES で送る(1,000通で0.1ドル)。
`AWS_ACCESS_KEY_ID`・`AWS_SECRET_ACCESS_KEY` を入れると SES に切り替わり、入れるまでは今までどおり Resend で送る(`src/mail.js`)。

1. AWS のアカウントを作り、SES の画面を**東京(ap-northeast-1)**で開く。
2. 「ID(Identities)」→「ID の作成」→ ドメイン `quiz-make.com`。Easy DKIM(RSA 2048)を選ぶ。
   出てきた CNAME 3つを Cloudflare の DNS に足す(プロキシはオフ = 灰色の雲)。
   「カスタム MAIL FROM ドメイン」に `ses.quiz-make.com` を入れ、出てきた MX と TXT(`v=spf1 include:amazonses.com ~all`)も足す
   (Apple の「メールを非公開」の転送アドレスへ届けるには SPF が要るため)。
3. 「アカウントダッシュボード」→「本番アクセスをリクエスト」。種類は「トランザクション」。
   **認められるまでは鍵を入れない**(それまでの SES は、確かめたアドレスにしか送れないため)。
4. IAM で、SES で送ることだけができるユーザーを作り、アクセスキーを作る。ポリシー:

   ```json
   { "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": "ses:SendEmail", "Resource": "*",
     "Condition": { "StringEquals": { "ses:FromAddress": "no-reply@quiz-make.com" } } }] }
   ```

5. (任意)「設定セット」を作り、届かなかった・迷惑メールにされた数を見られるようにする。名前を `wrangler.jsonc` の `vars` に
   `"SES_CONFIGURATION_SET": "…"` と書く。「アカウントレベルのサプレッションリスト」(届かなかったアドレスへ二度と送らない)は、はじめから有効になっている。
   届かない割合が 5% を超えると SES の審査に入るので、ダッシュボードの「評判メトリクス」をときどき見る。
6. 本番アクセスが認められたら、鍵を入れて配信する。

   ```
   npx wrangler secret put AWS_ACCESS_KEY_ID
   npx wrangler secret put AWS_SECRET_ACCESS_KEY
   npx wrangler deploy
   ```

   入れたら、自分のアドレスでログインの番号を送ってみて、届くことを確かめる(IAM の条件の書き方が合っていないと `ses failed 403` になる)。
   SES で送れないとき、ログに `ses failed 403 …` などが出る。Resend に戻すには `wrangler.jsonc` の `vars` に `"MAIL_PROVIDER": "resend"` と書いて配信する。

## Apple・Google でログインする

メールを使わずにログインできるようにする(`src/oauth.js`)。設定の値を入れた方法だけ、アプリにボタンが出る。
はじめに表を足す(`identities`・`oauth_flows`・`unverified_emails`): `npx wrangler d1 execute daigaku-note --remote --file=schema.sql`
(配信より先に流す。何度流しても壊れない)

**Google**(Google Cloud のコンソール)

1. プロジェクトを作り、「Google Auth Platform」→「ブランディング」でアプリ名「かきためノート」・サポートのメールを入れる。対象は「外部」。
2. 「対象」で**アプリを公開する**(「テスト中」のままだと、テストユーザーに入れた人しかログインできない)。使うのは `openid`・`email` だけなので、審査は要らない。
3. 「クライアント」→「クライアントを作成」→ 種類は「ウェブ アプリケーション」。
   承認済みのリダイレクト URI に `https://note-api.quiz-make.com/oauth/google/callback` を入れる。
4. 出てきたクライアント ID とシークレットを入れる。

   ```
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

**Apple**(Apple Developer の Certificates, Identifiers & Profiles。Apple Developer Program への登録が要る)

1. Identifiers の App ID `io.github.jagjagyt.daigakunote` で「Sign in with Apple」を有効にする(なければ作る)。
2. Identifiers →「+」→「Services IDs」で、例えば `io.github.jagjagyt.daigakunote.signin` を作る。
   「Sign in with Apple」を有効にして Configure: Primary App ID は 1 のもの、Domains に `note-api.quiz-make.com`、
   Return URLs に `https://note-api.quiz-make.com/oauth/apple/callback`。
3. Keys →「+」→「Sign in with Apple」を有効にし、横の Configure で Primary App ID に 1 のものを選んで作る。
   .p8 をダウンロードする(1回しかできない)。Key ID を控える。
4. Team ID(右上の名前の下、または Membership)を控えて、4つを入れる。

   ```
   npx wrangler secret put APPLE_CLIENT_ID        … 2 の Services ID
   npx wrangler secret put APPLE_TEAM_ID
   npx wrangler secret put APPLE_KEY_ID
   type AuthKey_XXXXXXXXXX.p8 | npx wrangler secret put APPLE_PRIVATE_KEY    … Windows。Mac は cat
   ```

5. 「メールを非公開」を選んだ人には、Apple が作った転送用のアドレス(…@privaterelay.appleid.com)が届く。
   そこへお知らせを届けるため、Services →「Sign in with Apple for Email Communication」に `quiz-make.com` と `no-reply@quiz-make.com` を登録する。
   登録したら、転送用のアドレスの人へ実際に届くかを確かめる(届かなければ `ses.quiz-make.com` も登録する)。

入れたら `npx wrangler deploy`。`curl https://note-api.quiz-make.com/oauth/providers` で `{"apple":true,"google":true}` になればよい。

アカウントのつなぎ方:
- 同じ Apple・Google のアカウントなら、メールアドレスが変わっても同じかきためノートのアカウント。
- メールの番号で作ったアカウントと同じアドレスなら、そのアカウントにつなぐ。ただし、そのアドレスの今の持ち主だと言い切れるときだけ:
  Google は Gmail か Google Workspace のアドレス、Apple は「メールを非公開」の転送用のアドレスか iCloud のアドレス。
  (Google・Apple のアカウントにほかの会社のアドレスを付けた人は、そのアドレスを今も持っているとは限らない。卒業した大学のアドレスなど)
  それ以外で前からのアカウントがあるときは、つながずに「メールアドレスに届く番号でログインしてください」と出す。
- 持ち主と言い切れないアドレスで新しく作ったアカウントには印(`unverified_emails`)を付ける。そのアドレスでメールの番号を確かめた人・
  別の Apple・Google のアカウントで来た人には、勝手に入れず・つながず、「○○のアカウントから作られたアカウントがあります」と作った方法を伝える
  (同じ人が Apple と Google を使い分けていることが多いため、黙って別のアカウントにしない)。
  メールの番号の人が「新しいアカウントを作成」を選んだときだけ、印のアカウントからアドレスを外し(`<id>@unverified.invalid`。Apple・Google でだけ入れる)、新しく作る。
  アドレスを外したアカウントには、長く使われていないときのお知らせが届かない(お知らせなしで、期限が来たら片づける)。
- 退会・長く使われていないアカウントの片づけでは、Apple に取り消し(revoke)を頼む(App Store の決まり)。
- ブラウザ版で戻すのは `https://jagjag-yt.github.io/daigaku-note/` だけ。手元の試験の住所(localhost)は `DEV_OAUTH_RETURNS=1` のときだけ。
- アプリ版は、ログインの画面を OS のブラウザの画面で開き、`io.github.jagjagyt.daigakunote:/auth` で戻ってくる(Info.plist・AndroidManifest.xml に登録)。
  アプリ版のボタンは、アプリを作り直して(`npm run cap:sync` のあと Xcode・Android Studio でビルド)出し直したバージョンから出る。

## クーポンコードを配る

テストに協力してくれた人への「広告なし」などの特典は、クーポンコードで配る。

- コードを作れるのは、Cloudflare にログインしたパソコン(`npx wrangler login` 済み)だけ。サーバーには発行の受け口がなく、
  `scripts/coupon.mjs` が D1 に直接書き込む。
- 1つのコードは1回だけ使える。使う人は、ブラウザ版の「アカウント」の「特典」の欄にコードを入れる。
  アプリ版(App Store・Google Play)には入力欄を出さない(ストアの課金を通さずに機能を開ける仕組みを、ストアの決まりでアプリに置けないため)。
  ブラウザ版で付けた特典は、同じアカウントならアプリ版でも効く。
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
**schema.sql は、この変更を main に入れる前に流す**(2026-11-18 より前に一度流していて、`inactive_notices` の表がすでにある場合は、`npx wrangler d1 execute daigaku-note --remote --command "ALTER TABLE inactive_notices ADD COLUMN purging INTEGER NOT NULL DEFAULT 0"` も1回だけ流す)(手順6の自動デプロイをつないでいると、main に入った時点で新しいサーバーが動くため)。
表がないまま動いても、`/me` の特典が空になり、`/coupon` が失敗するだけで、ログイン・同期・退会は止まらない。

```
npx wrangler d1 execute daigaku-note --remote --file=schema.sql
npx wrangler deploy
```

## ストアの審査用のアカウント

App Store・Google Play の審査の担当者は、ログインの番号のメールを受け取れない。そこで、決めておいた6桁の番号で入れるアドレスを1つだけ用意できる。

```
npx wrangler secret put REVIEW_EMAIL    … 例: review-7k3q9x@quiz-make.com(受信箱がなくてよい。推測されにくいものにする)
npx wrangler secret put REVIEW_CODE     … 6桁の数字。123456 のような推測しやすいものは避ける
```

- このアドレスにはメールを送らず、REVIEW_CODE を「送った番号」にする。1回の番号で5つまで試せるのはほかと同じ。
- 番号が決まっているので、番号を出す回数は IP ごとに1日5回・サービス全体で1日50回まで(試せるのは全体で1日250通り)。
- 入れたら、一度自分で「アカウントを作成」から REVIEW_EMAIL と REVIEW_CODE で作っておく(審査の人は「ログイン」から入る)。
- 365日使われないと片づけの対象になるので、クーポン(`--perk pro` など、期限なし)を1つ付けておくと消えない。
- 審査の申し込みのフォームの「サインイン情報」に、このアドレスと番号を書く。くわしくは docs/ストア公開.md。

## 手元で動かす

```
npx wrangler d1 execute daigaku-note --local --file=schema.sql
npx wrangler dev --var SECRET_PEPPER:testpepper --var RESEND_API_KEY:dummy --var DEV_ECHO_OTP:1 --var OTP_BURST_SECONDS:0 --var DEV_OAUTH_RETURNS:1
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
- `test/oauth.test.mjs` … SES の署名(AWS の部品と同じになるか)、Apple・Google でのログイン(引換券・合言葉・つなぎ方)
- `test/ui/account.spec.js`(`npm run test:ui`)… ログインしないと使えないこと、ログインとアカウント作成のページ、2台で同期・端末を外す・ログアウト・アカウントの削除

## 無料プランの上限で気をつけること

- R2 は保存 10GB・書き込み(PUT など)月100万回・読み取り(GET・HEAD)月1,000万回まで無料。中身(変更のファイル・PDF・画像)はここに入る。
  1人 1GB までなので、全員が上限まで使うと10人で埋まる。実際の使い方は1人数十MB〜数百MBの見込み。
  ダッシュボードの R2 の画面で使っている量を見ておき、10GB に近づいたら上限を下げるか、超えた分を払う(1GB あたり月 0.015 ドル)。
- D1 は1つのデータベースが 500MB まで(無料プラン)。入るのは目録(1ファイル数十バイト)・利用者・端末だけなので、数千人でも収まる。
- D1 の書き込みは1日10万行、読み取りは1日500万行まで。変更のファイル1つで書き込みは3〜4行。同期は1分ごとに `ops/` を一覧する(読み取り)。
- Workers は1日10万回まで。1台の端末が開きっぱなしだと、1分ごとの同期で1日に約1,500回(常に開いている端末が60台ほどで上限)。
