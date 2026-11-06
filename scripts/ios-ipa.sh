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
  -clonedSourcePackagesDirPath build/spm \
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
# 起動に要るフレームワーク(ないと起動した瞬間に落ちる)と、中の Mach-O が全部 arm64 向けか
for fw in Capacitor Cordova; do
  test -f "$APP/Frameworks/$fw.framework/$fw" || { echo "::error::$fw.framework が入っていません"; exit 1; }
done
files=$(find "$APP" -type f) || { echo "::error::App.app の中を調べられません"; exit 1; }
while IFS= read -r bin; do
  case "$(file -b "$bin")" in *Mach-O*) ;; *) continue ;; esac
  a=$(lipo -archs "$bin") || { echo "::error::${bin#"$APP"/} のアーキテクチャを読めません"; exit 1; }
  [[ " $a " == *" arm64 "* ]] || { echo "::error::${bin#"$APP"/} が実機(arm64)向けになっていません"; exit 1; }
done <<< "$files"

# .ipa は「Payload/App.app」を入れた zip
work=$(mktemp -d) || { echo "::error::作業用のフォルダを作れません"; exit 1; }
trap 'rm -rf "$work"' EXIT
IPA="$PWD/$OUT/daigaku-note-unsigned.ipa"
mkdir "$work/Payload" && ditto "$APP" "$work/Payload/App.app" || { echo "::error::Payload を作れません"; exit 1; }
(cd "$work" && zip -qrX -y "$IPA" Payload) || { echo "::error::.ipa を作れません"; exit 1; }
# 中に本体があるか(見つからなければ unzip は 0 以外で終わる)
unzip -l "$IPA" 'Payload/App.app/App' > /dev/null || { echo "::error::.ipa の中身がおかしい"; exit 1; }
ls -la "$OUT"
