#!/bin/bash
# iPhone・iPad の実機用に、署名なしの .ipa を作る(GitHub Actions の Mac で動かす。Xcode が要る)。
# Windows の Sideloadly などで、自分の Apple ID で署名し直して入れるためのもの。
#   出力: ios-ipa/daigaku-note-unsigned.ipa
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=ios-ipa
rm -rf "$OUT" && mkdir -p "$OUT"

if ! xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build/ios-device \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build > "$OUT/xcodebuild.log" 2>&1; then
  grep -E 'error:|BUILD FAILED|The following build commands failed' "$OUT/xcodebuild.log" | head -n 40
  echo "::error::実機用のアプリを作れませんでした(全部のログは Artifacts の xcodebuild.log)"
  exit 1
fi
APP=build/ios-device/Build/Products/Release-iphoneos/App.app
test -f "$APP/App" || { echo "::error::App.app ができていません"; exit 1; }
archs=$(lipo -archs "$APP/App") || { echo "::error::App のアーキテクチャを読めません"; exit 1; }
echo "App: $archs"
[[ " $archs " == *" arm64 "* ]] || { echo "::error::実機(arm64)向けになっていません"; exit 1; }
test -f "$APP/public/index.html" || { echo "::error::画面のファイル(public/index.html)が入っていません"; exit 1; }

# .ipa は「Payload/App.app」を入れた zip
work=$(mktemp -d)
mkdir "$work/Payload" && ditto "$APP" "$work/Payload/App.app" || { echo "::error::Payload を作れません"; exit 1; }
(cd "$work" && zip -qry - Payload) > "$OUT/daigaku-note-unsigned.ipa" || { echo "::error::.ipa を作れません"; exit 1; }
rm -rf "$work"
unzip -l "$OUT/daigaku-note-unsigned.ipa" | grep -q 'Payload/App.app/App$' || { echo "::error::.ipa の中身がおかしい"; exit 1; }
ls -la "$OUT"
