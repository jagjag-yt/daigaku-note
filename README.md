# 大学ノート(v0.2)

GoodNotes の代わりを目指す、無料・オフライン・クロスプラットフォームの手書きノート。
Web 技術(PWA)1本で Windows と iPad の両方で動く。ビルド不要、依存ライブラリは `vendor/` に同梱。
同じ画面を Capacitor で包んだ Android / iOS アプリ版もある(Android を先に進めている。くわしくは [docs/アプリ化.md](docs/アプリ化.md))。

## できること

- ペン(Apple Pencil / Windows のペンの筆圧に対応)。線は滑らかなベクター(輪郭を塗ったパス)なので、拡大しても PDF にしても滑らか
- 蛍光ペン(下の文字が透けて見える)
- 図形補正:書き終わりでペンを止めると、直線・円・楕円・三角形・四角形に整える(「図形補正」でオン/オフ)
- 消しゴム(線ごとに消す。ペンの消しゴムボタンにも対応)
- 投げ縄:囲んで選び、ドラッグで移動。削除・複製・色の変更もできる
- 元に戻す / やり直す(Ctrl+Z / Ctrl+Y)
- テンプレート:A罫・B罫・C罫・方眼・ドット・コーネル式・五線譜・無地。用紙は A4 縦横・B5・A5・16:9
- ページ一覧:並べ替え、テンプレートの変更、追加、削除
- ノート一覧(作成・名前変更・削除・1冊ずつ書き出し)
- 端末内(IndexedDB)に自動保存。ネットなしで全部使える
- PDF を開いて上から書き込む / ノートに PDF のページを追加
- PDF 書き出し(元の PDF はそのまま残し、その上に手書きをベクターで重ねる)
- 検索:ノートの名前、PDF の文字
- クラウド同期(WebDAV / Nextcloud)と、ファイルでの同期
- GoodNotes のノート(.goodnotes)の取り込み(手書き・用紙・画像・テキストボックス・付箋)
- 指はスクロールとピンチズーム、書くのはペンだけ(「指で書く」で切り替え)
- ホーム画面に追加すればアプリとして起動、オフラインでも起動

ショートカット:P ペン / H 蛍光ペン / E 消しゴム / L 投げ縄 / Delete 選択を削除 / Esc 選択解除

## 起動のしかた

### Windows

Node.js が入っていれば、`start-windows.bat` をダブルクリック(または `node serve.mjs`)。
ブラウザで http://localhost:8123/ が開く。Edge なら「アプリとしてインストール」でアプリになる。

### iPad

いちばん簡単なのは、このフォルダをどこか https で公開すること(GitHub Pages、Cloudflare Pages、Netlify など。
静的ファイルを置くだけ)。Safari で開いて「共有 → ホーム画面に追加」。

試すだけなら、Windows で `node serve.mjs` を動かし、同じ Wi-Fi の iPad から表示された
`http://192.168.x.x:8123/` を開く。ただし https でないのでオフライン起動はできない。

### Android(アプリ版)

[docs/アプリ化.md](docs/アプリ化.md) を参照。Android Studio のエミュレーターで動かす手順と、
Android Studio なしで APK を入れる方法(GitHub Actions が作る)を書いてある。

## 同期のしかた

### クラウド同期(WebDAV / Nextcloud)

一覧の「同期」から、WebDAV のフォルダの URL・ユーザー名・アプリパスワードを入れて「保存して今すぐ同期」。
以後は変更の数秒後と1分ごとに自動で同期する。自前のサーバープログラムは要らない(Saber と同じ考え方)。

- Nextcloud の URL の例:`https://<サーバー>/remote.php/dav/files/<ユーザー名>/`
- パスワードは Nextcloud の「設定 → セキュリティ → アプリパスワード」で作ったものを使う
- **CORS の許可が必要(ブラウザ版だけ)**:大学ノートはブラウザから直接 WebDAV に接続するので、サーバーが
  `https://jagjag-yt.github.io` からの接続を許可していないと失敗する。Nextcloud なら
  「WebAppPassword」アプリを入れて、許可するオリジンに `https://jagjag-yt.github.io` を追加する。
  ほかの WebDAV サーバーでも、CORS(`Access-Control-Allow-Origin` など)を返す設定が必要。
  アプリ版(Android / iOS)は OS の通信機能で直接つなぐので、CORS の設定は要らない
- サーバーには `daigaku-note/ops/<端末ID>/*.json`(各端末の変更)と `daigaku-note/files/*.pdf` を置く
- 各端末は「ほかの端末の変更を何番まで読んだか」だけを覚えて、その続きだけを読む。変わっていない端末のフォルダは中を見ない
  (フォルダの ETag で判断。くわしくは `docs/設計.md`)

### ファイルで同期

1. 端末Aの一覧で「同期」→「同期ファイルを書き出す」
2. そのファイルを OneDrive / Google ドライブ / AirDrop などで端末Bへ
3. 端末Bで「同期」→「同期ファイルを取り込む」

どちらの方法でも、何回取り込んでも、どの順で取り込んでも同じ結果になる。

## GoodNotes からの取り込み

一覧の「GoodNotesから取り込む」で `.goodnotes` を選ぶ(複数可)。
GoodNotes の形式は公開されていないため、実物を調べて分かった範囲で読んでいる。

- 取り込めるもの:ノートの名前、ページの順番と大きさ、手書きの線(色・太さ・筆圧による太さの変化)、半透明の線(蛍光ペンとして)、鉛筆(筆圧つきのペンとして)、
  図形、消した線の除外、背景の PDF、画像、テキストボックス、付箋
- 取り込めないもの:鉛筆などの質感、画像の回転・切り抜き、リンク、音声

## 検索

一覧の検索欄で、ノートの名前と PDF のページの文字を探せる。手書き文字の認識は今は行わない
(将来、手書きを認識して文字入力や数式に変換する機能を作るときに、手書き向けの方法で入れる予定)。

## しくみ

- ノートは「変更(op)の記録」の積み重ね。op には `{端末ID, 端末内の連番, ランポート時計}` が付く。
- 状態は op をどの順で適用しても同じになるように作ってある(線・ページの「ある/消えた」、名前、ページ順をそれぞれ LWW で決める)。
  だから同期は「相手が持っていない op を送る」だけ。GoodNotes の .goodnotes の中身(端末ごとの時計付きイベント記録)と同じ考え方。
- PDF は SHA-256 で名前を付けて丸ごと1つ保存し、ページは「どの PDF の何ページ目か」を参照するだけ。
- 主なファイル
  - `js/model.js` データモデルとマージ(DOM なし、Node でテスト可)
  - `js/ink.js` 線の形(滑らかな中心線・筆圧の輪郭)、図形補正、投げ縄の判定
  - `js/templates.js` テンプレートと用紙サイズ
  - `js/search.js` 検索
  - `js/webdav.js` クラウド同期
  - `js/goodnotes.js` .goodnotes の取り込み
  - `js/db.js` IndexedDB
  - `js/pdf.js` PDF の読み込み(pdf.js)と書き出し(pdf-lib)
  - `js/sync.js` 同期ファイル
  - `js/app.js` 画面と入力
  - `sw.js` オフライン用 Service Worker
- 設計の考え方と GoodNotes の調査からの反映: `docs/設計.md`
- メールのログインだけで同期できる同期サーバー(Cloudflare Workers): `server/`(手順は `server/README.md`)

### 同期ファイルの形式(v1)

```json
{
  "format": "daigaku-note-sync", "version": 1, "device": "端末ID", "exportedAt": "ISO時刻",
  "ops": [{ "id": "端末ID:連番", "d": "端末ID", "c": 1, "l": 1, "n": "ノートID", "t": "stroke.add", "p": {}, "ts": 0 }],
  "files": [{ "hash": "sha256", "name": "a.pdf", "type": "application/pdf", "data": "data:...base64" }]
}
```

op の種類: `note.create / note.rename / note.delete / note.restore / page.add / page.delete / page.restore / page.move / page.bg / stroke.add / stroke.del / stroke.undel / stroke.tf(移動) / stroke.style(色)`。
線の点は `[x, y, 筆圧, x, y, 筆圧, ...]`(単位は pt、ページ左上が原点)。

## テスト

```
npm test                       # マージ・図形補正・同期のカーソル・GoodNotes の線の読み方・アプリ版の通信・同期サーバーのテスト(Node)
npm ci && npm run test:ui      # 画面の崩れのテスト(8つの画面の大きさ × Chromium・WebKit。docs/アプリ化.md)
node test/native-e2e.cjs       # アプリ版(Android)の動きをブラウザで再現して確かめる(サーバーは上と同じ)
node serve.mjs 8124 &          # アプリ
node test/davserver.mjs 8125 & # テスト用 WebDAV サーバー
npm i pdf-lib && URL=http://localhost:8124/ GN=見本.goodnotes node test/e2e.cjs /tmp   # ブラウザでの通し確認(Playwright)
```

## まだないもの(次の候補)

- 画像・テキストの貼り付け(取り込んだものの表示・移動はできる)
- 手書き文字の認識(文字入力・数式への変換)
- フォルダ分け(設計は `docs/設計.md`)、ページのサムネイル一覧からのドラッグでの並べ替え
- Google ドライブ・OneDrive への直接の同期

## ライセンス

大学ノート本体は MIT。同梱の pdf.js は Apache-2.0、pdf-lib は MIT(`vendor/` にライセンス文)。
