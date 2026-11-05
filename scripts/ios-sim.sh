#!/bin/bash
# iOS のシミュレーター用にアプリを作り、iPhone と iPad のシミュレーターで起動して確かめる。
# GitHub Actions の Mac(macos)で動かす。手元の Mac でも動く(Xcode が要る)。
# 手元で使うと、選んだシミュレーターに入っている大学ノートのデータは消える(空の本棚で確かめるため入れ直す)。
#
# 確かめること(端末ごと):
#   1. 画面のプログラムが動いた … WebView の IndexedDB にファイルができる(フォルダだけなら JS がなくてもできる)
#   2. プログラムが本棚を描いた … スクショに本棚の地の色が一定の割合あり、プログラムが描く「新規」のカードの
#      アクセント色がある(scripts/screen-check.py。真っ白・起動画面・ホーム画面・HTML だけの画面では失敗)
#   3. 落ちていない … 起動したプロセスが、画面が出たあとも生きている
# 出力(ios-out/): daigaku-note-simulator.zip(Appetize.io などに上げられる .app)、<端末名>.png、
#                  xcodebuild.log、落ちたときの診断レポート
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=ios-out
rm -rf "$OUT" && mkdir -p "$OUT"
BUNDLE=io.github.jagjagyt.daigakunote
# 毎回同じ機種で撮る(なければ、いちばん新しい iOS の同じ種類の機種)
IPHONE=${IPHONE:-"iPhone 17 Pro"}
IPAD=${IPAD:-"iPad Pro 13-inch (M5)"}

echo "== $(xcodebuild -version | tr '\n' ' ')"
# 署名なし・Intel と Apple シリコンの両方の Mac 向け(Appetize.io などでも動くように)
if ! xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/ios ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO \
  build > "$OUT/xcodebuild.log" 2>&1; then
  grep -E 'error:|BUILD FAILED|The following build commands failed' "$OUT/xcodebuild.log" | head -n 40
  echo "::error::iOS アプリを作れませんでした(全部のログは Artifacts の xcodebuild.log)"
  exit 1
fi
APP=build/ios/Build/Products/Debug-iphonesimulator/App.app
test -d "$APP" || { echo "::error::App.app ができていません"; exit 1; }
test -f "$APP/App" || { echo "::error::App.app に本体がありません"; exit 1; }
# 本体・デバッグ用の本体・中のフレームワーク(Capacitor など)の Mach-O を全部見る(実行の印の有無に関係なく)
files=$(find "$APP" -type f) || { echo "::error::App.app の中を調べられません"; exit 1; }
checked=0
while IFS= read -r bin; do
  file -b "$bin" | grep -q 'Mach-O' || continue
  archs=$(lipo -archs "$bin")
  echo "${bin#"$APP"/}: $archs"
  [[ " $archs " == *" x86_64 "* && " $archs " == *" arm64 "* ]] || { echo "::error::${bin#"$APP"/} が Intel・Apple シリコンの両方向けになっていません"; exit 1; }
  [ "$bin" = "$APP/App" ] && checked=1
done <<< "$files"
[ "$checked" = 1 ] || { echo "::error::App 本体のアーキテクチャを確かめられませんでした"; exit 1; }
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/daigaku-note-simulator.zip" || { echo "::error::zip を作れません"; exit 1; }

# 名前の決まった機種があればそれを、なければいちばん新しい iOS のその種類の機種を選ぶ
pick() {
  xcrun simctl list devices available -j | python3 -c '
import json, sys, re
want, kind = sys.argv[1], sys.argv[2]
best = None
for rt, devs in json.load(sys.stdin)["devices"].items():
    m = re.search(r"iOS-(\d+)-(\d+)", rt)
    if not m: continue
    ver = (int(m.group(1)), int(m.group(2)))
    for d in devs:
        key = (d["name"] == want, ver)
        if d["name"].startswith(kind) and (best is None or key > best[0]):
            best = (key, d["udid"], d["name"])
if best: print(best[1] + "\t" + best[2] + " (iOS %d.%d)" % best[0][1])
' "$1" "$2"
}

fail=0
check_device() {
  local want=$1 kind=$2 line name shot pid data rc ok=0
  line=$(pick "$want" "$kind")
  [ -n "$line" ] || { echo "::error::$kind のシミュレーターが見つかりません"; return 1; }
  # udid は呼ぶ側が端末を止めるのに使うので local にしない
  udid=${line%%$'\t'*}; name=${line#*$'\t'}
  shot="$OUT/${name// /_}.png"
  echo "== $name"
  # もともと起動していた端末(手元の Mac)は、終わっても止めない
  if xcrun simctl list devices | grep -F "$udid" | grep -q '(Booted)'; then udid_keep=1; fi
  xcrun simctl boot "$udid" 2>/dev/null
  xcrun simctl bootstatus "$udid" -b > /dev/null || { echo "::error::$name が起動しません"; return 1; }
  # 前に入れたときのデータ(IndexedDB)が残っていると、1. が素通りになるので消してから入れる
  xcrun simctl uninstall "$udid" "$BUNDLE" 2>/dev/null
  xcrun simctl install "$udid" "$APP" || { echo "::error::$name に入れられません"; return 1; }
  # 出力は「io.github.jagjagyt.daigakunote: 12345」。シミュレーターのアプリは Mac のプロセスなので ps で見られる
  pid=$(xcrun simctl launch "$udid" "$BUNDLE" | awk -F': ' '{print $2}')
  [[ "$pid" =~ ^[0-9]+$ ]] || { echo "::error::$name で起動できません"; return 1; }
  data=$(xcrun simctl get_app_container "$udid" "$BUNDLE" data)
  [ -n "$data" ] && [ -d "$data" ] || { echo "::error::$name のアプリのデータの場所が分かりません"; return 1; }
  # 画面が出るまで 3 秒ごとに見る(最大 90 秒。最初の起動は遅い)
  for _ in $(seq 1 30); do
    sleep 3
    ps -p "$pid" > /dev/null || break
    [ -n "$(find "$data/Library/WebKit" -path '*IndexedDB*' -type f -print -quit 2>/dev/null)" ] || continue
    xcrun simctl io "$udid" screenshot --type=bmp "$OUT/shot.bmp" > /dev/null 2>&1 || continue
    python3 scripts/screen-check.py "$OUT/shot.bmp" > "$OUT/check.txt"; rc=$?
    [ $rc -eq 2 ] && { cat "$OUT/check.txt"; echo "::error::$name のスクショを確かめられません"; return 1; }
    [ $rc -eq 0 ] && { ok=1; break; }
  done
  cat "$OUT/check.txt" 2>/dev/null
  xcrun simctl io "$udid" screenshot "$shot" > /dev/null 2>&1
  rm -f "$OUT/shot.bmp" "$OUT/check.txt"
  sleep 3
  if ! ps -p "$pid" > /dev/null; then
    echo "::error::$name でアプリが終わってしまいました(落ちた・画面のファイルが読めない など)"
    # この回の診断レポートだけを残す
    find ~/Library/Logs/DiagnosticReports -name 'App-*.ips' -newer "$OUT/xcodebuild.log" -exec cp {} "$OUT/" \; 2>/dev/null
    return 1
  fi
  if [ $ok -ne 1 ]; then
    echo "::error::$name で本棚の画面が出ません(起動画面のまま・真っ白 など)"
    find "$data/Library" -maxdepth 4 | head -n 30
    return 1
  fi
  echo "$name: 起動して本棚の画面が出た"
}

for dev in "$IPHONE|iPhone" "$IPAD|iPad"; do
  udid=""; udid_keep=0
  echo "::group::${dev#*|}"   # 実際の機種名は中の「== 」の行に出る
  check_device "${dev%%|*}" "${dev#*|}" || fail=1
  echo "::endgroup::"
  # 使った端末を止める(失敗した端末も。手元の Mac のほかのシミュレーターには触らない)
  [ -n "$udid" ] && [ "$udid_keep" = 0 ] && xcrun simctl shutdown "$udid" > /dev/null 2>&1
done
ls -la "$OUT"
exit $fail
