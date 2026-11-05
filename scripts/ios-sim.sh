#!/bin/bash
# iOS のシミュレーター用にアプリを作り、iPhone と iPad のシミュレーターで起動して確かめる。
# GitHub Actions の Mac(macos)で動かす。手元の Mac でも動く(Xcode が要る)。
#
# 確かめること(端末ごと):
#   1. 画面のプログラムが動いた … アプリのデータの場所に WebView の IndexedDB ができる(起動画面のままでは
#      できない)。scripts/screen-check.py だけでは起動画面と本棚の地の色が同じで見分けられないため
#   2. 本棚の画面が出ている … スクショの本棚の地の色の割合(真っ白・ホーム画面では足りない)
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
for bin in "$APP/App" "$APP/App.debug.dylib"; do
  [ -f "$bin" ] && echo "$(basename "$bin"): $(lipo -archs "$bin")"
done
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/daigaku-note-simulator.zip"

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
  local want=$1 kind=$2 line udid name shot pid data ok=0
  line=$(pick "$want" "$kind")
  [ -n "$line" ] || { echo "::error::$kind のシミュレーターが見つかりません"; return 1; }
  udid=${line%%$'\t'*}; name=${line#*$'\t'}
  shot="$OUT/${name// /_}.png"
  echo "::group::$name"
  xcrun simctl boot "$udid" 2>/dev/null
  xcrun simctl bootstatus "$udid" -b > /dev/null || { echo "::error::$name が起動しません"; return 1; }
  xcrun simctl install "$udid" "$APP" || { echo "::error::$name に入れられません"; return 1; }
  # 出力は「io.github.jagjagyt.daigakunote: 12345」。シミュレーターのアプリは Mac のプロセスなので ps で見られる
  pid=$(xcrun simctl launch "$udid" "$BUNDLE" | awk -F': ' '{print $2}')
  [[ "$pid" =~ ^[0-9]+$ ]] || { echo "::error::$name で起動できません"; return 1; }
  data=$(xcrun simctl get_app_container "$udid" "$BUNDLE" data)
  # 画面が出るまで 3 秒ごとに見る(最大 90 秒。最初の起動は遅い)
  for _ in $(seq 1 30); do
    sleep 3
    ps -p "$pid" > /dev/null || break
    find "$data/Library/WebKit" -path '*IndexedDB*' -type f 2>/dev/null | grep -q . || continue
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
    cp ~/Library/Logs/DiagnosticReports/App-*.ips "$OUT/" 2>/dev/null
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
  check_device "${dev%%|*}" "${dev#*|}" || fail=1
  echo "::endgroup::"
  # 次の端末のためにすべて止める(失敗した端末も)
  xcrun simctl shutdown all > /dev/null 2>&1
done
ls -la "$OUT"
exit $fail
