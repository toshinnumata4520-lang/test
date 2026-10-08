# 音読チェックを社内NASに公開する（初回も更新も、これ1つ）
# 使い方：エクスプローラーでこのファイルを右クリック →「PowerShell で実行」
#        または PowerShell で  powershell -ExecutionPolicy Bypass -File ondoku\nas-deploy.ps1

$ErrorActionPreference = 'Stop'
$Nas    = '192.168.0.4'
$Share  = "\\$Nas\docker\ondoku-demo"
$Dir    = '/volume1/docker/ondoku-demo'
$Key    = 'C:\Users\griff010\.ssh\synology_griff'
$User   = 'takezawa'
$Docker = 'sudo /usr/local/bin/docker'

try {
  Write-Host '1/3 NASにプログラムをコピーしています…' -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path $Share | Out-Null
  foreach ($f in 'Dockerfile', 'server.js', 'lib', 'public') {
    Copy-Item (Join-Path $PSScriptRoot $f) $Share -Recurse -Force
  }

  $EnvFile = Join-Path $Share 'ondoku.env'
  if (-not (Test-Path $EnvFile)) {
    Write-Host '2/3 初回の設定をします' -ForegroundColor Cyan
    $gemini = Read-Host 'Gemini の鍵（https://aistudio.google.com/apikey で作成したもの）'
    $code   = Read-Host '生徒に伝える合言葉（AI の助言に使います）'
    if (-not $gemini -or -not $code) { throw '鍵と合言葉の両方を入れてください' }
    $text = "GEMINI_API_KEY=$($gemini.Trim())`nACCESS_CODE=$($code.Trim())`nTRUST_PROXY=1`n"
    [IO.File]::WriteAllText($EnvFile, $text, (New-Object Text.UTF8Encoding $false))
  } else {
    Write-Host '2/3 設定は前回のものを使います（変えるときは ondoku.env を削除して再実行）' -ForegroundColor Cyan
  }

  Write-Host '3/3 NASで組み立てて起動します（NASのパスワードを聞かれたら入力）…' -ForegroundColor Cyan
  $cmd = "cd $Dir && $Docker build -t ondoku-demo . && ($Docker rm -f ondoku-demo >/dev/null 2>&1; true) && " +
         "$Docker run -d --name ondoku-demo --restart unless-stopped -p 127.0.0.1:3101:3100 --env-file $Dir/ondoku.env ondoku-demo && " +
         "sleep 2 && wget -qO- http://127.0.0.1:3101/api/config"
  ssh -t -i $Key "$User@$Nas" $cmd
  if ($LASTEXITCODE -ne 0) { throw 'NASでの起動に失敗しました（上の表示を Claude に貼ってください）' }

  Write-Host ''
  Write-Host '起動しました。{"needCode":true} と表示されていれば正常です。' -ForegroundColor Green
  Write-Host '初回だけ、DSM でリバースプロキシを作ってください：'
  Write-Host '  コントロールパネル → ログインポータル → 詳細設定 → リバースプロキシ → 作成'
  Write-Host '  名前 ondoku-demo ／ ソース HTTPS・ondoku.griff-juku.synology.me・443 ／ 宛先 HTTP・127.0.0.1・3101'
  Write-Host '公開先：https://ondoku.griff-juku.synology.me' -ForegroundColor Green
} catch {
  Write-Host "エラー：$($_.Exception.Message)" -ForegroundColor Red
}
Read-Host 'Enter で閉じます'
