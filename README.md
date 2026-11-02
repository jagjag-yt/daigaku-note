# 大学ノート(MVP v0.1)

GoodNotes の代わりを目指す、無料・オフライン・クロスプラットフォームの手書きノート。
Web 技術(PWA)1本で Windows と iPad の両方で動く。ビルド不要、依存ライブラリは `vendor/` に同梱。

## できること

- ペン(Apple Pencil / Windows のペンの筆圧に対応、5色・3段階の太さ)
- 消しゴム(線ごとに消す。ペンの消しゴムボタンにも対応)
- 元に戻す / やり直す(Ctrl+Z / Ctrl+Y)
- 複数ページ(B罫6mm・方眼5mm・無地)、ページの追加と削除
- ノート一覧(作成・名前変更・削除・1冊ずつ書き出し)
- 端末内(IndexedDB)に自動保存。ネットなしで全部使える
- PDF を開いて上から書き込む / ノートに PDF のページを追加
- PDF 書き出し(元の PDF はそのまま残し、その上に手書きを重ねるので文字の選択もできる)
- 同期の土台:同期ファイルを書き出し → もう一方の端末で取り込む。両方で書いた線は消えずに合わさる
- 指はスクロールとピンチズーム、書くのはペンだけ(「指で書く」で切り替え)
- ホーム画面に追加すればアプリとして起動、オフラインでも起動(https か localhost のとき)

## 起動のしかた

### Windows

Node.js が入っていれば、`start-windows.bat` をダブルクリック(または `node serve.mjs`)。
ブラウザで http://localhost:8123/ が開く。Edge なら「アプリとしてインストール」でアプリになる。

### iPad

いちばん簡単なのは、このフォルダをどこか https で公開すること(GitHub Pages、Cloudflare Pages、Netlify など。
静的ファイルを置くだけ)。Safari で開いて「共有 → ホーム画面に追加」。

試すだけなら、Windows で `node serve.mjs` を動かし、同じ Wi-Fi の iPad から表示された
`http://192.168.x.x:8123/` を開く。ただし https でないのでオフライン起動はできない。

## 同期のしかた(今の版)

1. 端末Aの一覧で「同期」→「同期ファイルを書き出す」
2. そのファイルを OneDrive / Google ドライブ / AirDrop などで端末Bへ
3. 端末Bで「同期」→「同期ファイルを取り込む」

逆向きも同じ。何回取り込んでも、どの順で取り込んでも同じ結果になる。

## しくみ

- ノートは「変更(op)の記録」の積み重ね。op には `{端末ID, 端末内の連番, ランポート時計}` が付く。
- 状態は op をどの順で適用しても同じになるように作ってある(線・ページの「ある/消えた」、名前、ページ順をそれぞれ LWW で決める)。
  だから同期は「相手が持っていない op を送る」だけ。GoodNotes の .goodnotes の中身(端末ごとの時計付きイベント記録)と同じ考え方。
- PDF は SHA-256 で名前を付けて丸ごと1つ保存し、ページは「どの PDF の何ページ目か」を参照するだけ。
- 主なファイル
  - `js/model.js` データモデルとマージ(DOM なし、Node でテスト可)
  - `js/db.js` IndexedDB
  - `js/pdf.js` PDF の読み込み(pdf.js)と書き出し(pdf-lib)
  - `js/sync.js` 同期ファイル
  - `js/app.js` 画面と入力
  - `sw.js` オフライン用 Service Worker

### 同期ファイルの形式(v1)

```json
{
  "format": "daigaku-note-sync", "version": 1, "device": "端末ID", "exportedAt": "ISO時刻",
  "ops": [{ "id": "端末ID:連番", "d": "端末ID", "c": 1, "l": 1, "n": "ノートID", "t": "stroke.add", "p": {}, "ts": 0 }],
  "files": [{ "hash": "sha256", "name": "a.pdf", "type": "application/pdf", "data": "data:...base64" }]
}
```

op の種類: `note.create / note.rename / note.delete / note.restore / page.add / page.delete / page.restore / page.move / stroke.add / stroke.del / stroke.undel`。
線の点は `[x, y, 筆圧, x, y, 筆圧, ...]`(単位は pt、ページ左上が原点)。

## テスト

```
npm test                     # マージのテスト(Node)
node serve.mjs 8123 &        # 別に起動しておく
npm i pdf-lib && node test/e2e.cjs /tmp   # ブラウザでの通し確認(Playwright)
```

## まだないもの(次の候補)

- クラウド自動同期(WebDAV / Nextcloud / Google ドライブ)
- 投げ縄選択・移動、蛍光ペン、図形、テキスト、画像
- 手書き文字の検索、ページの並べ替え・サムネイル、フォルダ
- 実機(iPad + Apple Pencil)での細かい調整はまだ。手のひら誤反応などあれば直す

## ライセンス

大学ノート本体は MIT。同梱の pdf.js は Apache-2.0、pdf-lib は MIT(`vendor/` にライセンス文)。
