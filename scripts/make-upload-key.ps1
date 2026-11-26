# かきためノート: Google Play に上げるアプリの「アップロード鍵」を作る(最初の1回だけ)。
# 使い方(Windows): このファイルを右クリック →「PowerShell で実行」。または PowerShell で
#   powershell -ExecutionPolicy Bypass -File scripts\make-upload-key.ps1
# ユーザーのフォルダ(C:\Users\<名前>\kakitame-upload-key)に、鍵(upload.jks)と、GitHub の Secrets に入れる値(github-secrets.txt)を作る。
# OneDrive で同期されがちな「ドキュメント」は避けている。
# 鍵とパスワードはリポジトリに入れない。なくすと Google に作り直しを頼むことになるので、USB メモリなどにも控える。
$ErrorActionPreference = 'Stop'

function Pause-End { Write-Host ''; Read-Host 'Enter キーで閉じます' | Out-Null }
trap {
  Write-Host "うまくいきませんでした: $_" -ForegroundColor Red
  Remove-Item Env:KAKITAME_KS_PW -ErrorAction SilentlyContinue
  # 鍵だけ残ってパスワードの控えがないと作り直せなくなるので、消しておく
  if ($jks -and $txt -and (Test-Path $jks) -and -not (Test-Path $txt)) { Remove-Item $jks -ErrorAction SilentlyContinue }
  Pause-End; exit 1
}

$dir = Join-Path $env:USERPROFILE 'kakitame-upload-key'
$jks = Join-Path $dir 'upload.jks'
$txt = Join-Path $dir 'github-secrets.txt'
if (Test-Path $jks) {
  Write-Host "すでに鍵があります: $jks" -ForegroundColor Yellow
  Write-Host '作り直すと、前の鍵で上げたアプリを更新できなくなります。作り直すときは、先にフォルダごと別の場所へ移してください。'
  Pause-End; exit 1
}

# keytool を探す(Android Studio に入っている Java か、入れてある Java)
$candidates = @(
  "$env:ProgramFiles\Android\Android Studio\jbr\bin\keytool.exe",
  "$env:LOCALAPPDATA\Programs\Android Studio\jbr\bin\keytool.exe"
)
if ($env:JAVA_HOME) { $candidates += (Join-Path $env:JAVA_HOME 'bin\keytool.exe') }
$candidates += @(Get-ChildItem "$env:ProgramFiles\Eclipse Adoptium\*\bin\keytool.exe", "$env:ProgramFiles\Java\*\bin\keytool.exe", "$env:ProgramFiles\Microsoft\jdk-*\bin\keytool.exe" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
$cmd = Get-Command keytool.exe -ErrorAction SilentlyContinue
if ($cmd) { $candidates += $cmd.Source }
$keytool = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $keytool) {
  Write-Host 'keytool が見つかりません。Java を入れてから、もう一度実行してください。' -ForegroundColor Red
  Write-Host '例: https://adoptium.net/ から「Temurin 21 (LTS)」の Windows 用インストーラー(.msi)を入れる'
  Pause-End; exit 1
}
Write-Host "keytool: $keytool"

# パスワードは打たなくてよいよう、長い乱数で作る(英数字 32 文字)。
# ほかのプログラムから見えないよう、コマンドの引数ではなく環境変数で keytool に渡す。
$chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$pw = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
$env:KAKITAME_KS_PW = $pw

New-Item -ItemType Directory -Force -Path $dir | Out-Null

# keytool は進み具合を標準エラーに出す。Windows PowerShell 5.1 ではそれがエラー扱いで止まるので、ここだけ止めない。
$ErrorActionPreference = 'Continue'
& $keytool -genkeypair -keystore $jks -storetype PKCS12 -alias upload -keyalg RSA -keysize 2048 -validity 10000 -storepass:env KAKITAME_KS_PW -keypass:env KAKITAME_KS_PW -dname 'CN=Kakitame Note'
$code = $LASTEXITCODE
$listing = & $keytool -list -v -keystore $jks -storepass:env KAKITAME_KS_PW -alias upload 2>$null
$ErrorActionPreference = 'Stop'
Remove-Item Env:KAKITAME_KS_PW -ErrorAction SilentlyContinue

if ($code -ne 0 -or -not (Test-Path $jks)) {
  if (Test-Path $jks) { Remove-Item $jks }
  Write-Host '鍵を作れませんでした。上のメッセージを確かめて、もう一度実行してください。' -ForegroundColor Red
  Pause-End; exit 1
}

$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($jks))
$fpLine = $listing | Select-String 'SHA256:' | Select-Object -First 1
$fp = if ($fpLine) { $fpLine.ToString().Trim() } else { '(読めませんでした)' }
@"
かきためノート: GitHub の Secrets に入れる値(リポジトリの Settings → Secrets and variables → Actions → New repository secret)
このファイルと upload.jks は、ほかの人に見せない・リポジトリに入れない。USB メモリなどにも控えておく。

名前: ANDROID_KEYSTORE_BASE64
値:   (下の長い1行をすべて)
$b64

名前: ANDROID_KEYSTORE_PASSWORD
値:   $pw

名前: ANDROID_KEY_ALIAS
値:   upload

(ANDROID_KEY_PASSWORD は入れなくてよい。ストアのパスワードと同じ)

アップロード鍵の指紋(Play Console に出るものと同じか確かめるとき用): $fp
"@ | Set-Content -Encoding UTF8 -Path $txt

Write-Host ''
Write-Host "できました: $dir" -ForegroundColor Green
Write-Host "  upload.jks          … 鍵"
Write-Host "  github-secrets.txt  … GitHub の Secrets に入れる値"
Write-Host ''
Write-Host 'github-secrets.txt をメモ帳で開き、3つの値を GitHub に入れてください。'
Start-Process explorer.exe $dir
Pause-End
