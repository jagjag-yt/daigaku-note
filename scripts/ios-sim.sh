#!/bin/bash
# iOS のシミュレーター用にアプリを作り、iPhone と iPad のシミュレーターで起動してスクショを撮る。
# GitHub Actions の Mac(macos)で動かす。手元の Mac でも動く(Xcode が要る)。
#   出力: ios-out/daigaku-note-simulator.zip(Appetize.io などに上げられる .app)
#         ios-out/<端末名>.png(起動して少し待ったあとの画面)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=ios-out
rm -rf "$OUT" && mkdir -p "$OUT"
BUNDLE=io.github.jagjagyt.daigakunote

echo "== Xcode: $(xcodebuild -version | head -1)"
# 署名なし・Intel と Apple シリコンの両方の Mac 向け(Appetize.io などでも動くように)
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/ios ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO \
  build | tail -n 30
APP=build/ios/Build/Products/Debug-iphonesimulator/App.app
test -d "$APP" || { echo "::error::App.app ができていません"; exit 1; }
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/daigaku-note-simulator.zip"

# 使えるシミュレーターから、いちばん新しい iOS の iPhone と iPad を1台ずつ選ぶ
pick() {
  xcrun simctl list devices available -j | python3 -c '
import json, sys, re
kind = sys.argv[1]
best = None
for rt, devs in json.load(sys.stdin)["devices"].items():
    m = re.search(r"iOS-(\d+)-(\d+)", rt)
    if not m: continue
    ver = (int(m.group(1)), int(m.group(2)))
    for d in devs:
        if d["name"].startswith(kind) and (best is None or ver > best[0]):
            best = (ver, d["udid"], d["name"])
if best: print(best[1] + "\t" + best[2] + " (iOS %d.%d)" % best[0])
' "$1"
}

fail=0
for kind in "iPhone" "iPad"; do
  line=$(pick "$kind")
  if [ -z "$line" ]; then echo "::error::$kind のシミュレーターが見つかりません"; fail=1; continue; fi
  udid=${line%%$'\t'*}; name=${line#*$'\t'}
  echo "::group::$name"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b > /dev/null
  xcrun simctl install "$udid" "$APP"
  xcrun simctl launch "$udid" "$BUNDLE"
  sleep 20   # 画面が出るまで(最初の起動は遅い)
  # 落ちていないか(起動したアプリが動き続けているか)
  # (grep -q にパイプでつなぐと、pipefail で launchctl 側の SIGPIPE を失敗と取り違えるので、いったん受け取る)
  running=$(xcrun simctl spawn "$udid" launchctl list)
  if ! grep -q "$BUNDLE" <<<"$running"; then
    echo "::error::$name でアプリが落ちました"
    xcrun simctl spawn "$udid" log show --last 2m --style compact --predicate "process == \"App\"" | tail -n 80 || true
    fail=1
  fi
  shot="$OUT/${name// /_}.png"
  xcrun simctl io "$udid" screenshot "$shot"
  # 画面が真っ白のまま(画面のファイルが読めていない)でないか
  if ! python3 scripts/png-blank.py "$shot"; then echo "::error::$name で画面が出ていません(真っ白)"; fail=1; fi
  xcrun simctl shutdown "$udid" || true
  echo "::endgroup::"
done
ls -la "$OUT"
exit $fail
