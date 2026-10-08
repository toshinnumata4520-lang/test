# 音読チェック 試しに使う手順

## A. 自分のパソコンですぐ試す（5分）

パソコンのマイクで試す方法です。スマホからは使えません。

1. Node.js（版22以上）を入れる：https://nodejs.org/ja
2. Gemini の鍵を作る：https://aistudio.google.com/apikey で「API キーを作成」
3. このリポジトリのフォルダで、PowerShell から：
   ```powershell
   $env:GEMINI_API_KEY="作った鍵"
   npm run ondoku
   ```
4. Chrome か Edge で http://localhost:3100 を開き、マイクを「許可」する

## B. 社内NASで公開する（スマホ・タブレットからも使える）

下校時刻デモ（`docs/NAS公開手順.md`）と同じやり方です。

### 公開先
- URL：**https://ondoku.griff-juku.synology.me**（証明書は既存のワイルドカードを使用）

### 構成
| 項目 | 内容 |
|---|---|
| 置き場所 | `/volume1/docker/ondoku-demo/`（共有フォルダ `\\192.168.0.4\docker\ondoku-demo`） |
| 設定ファイル | `ondoku.env`（鍵と合言葉。このリポジトリには入れない） |
| コンテナ名 | `ondoku-demo`（`--restart unless-stopped`） |
| ポート | NAS内の `127.0.0.1:3101` → コンテナ `3100`（3100番は下校時刻デモが使用中） |
| データ | なし（録音も保存しない） |

### 手順
1. 共有フォルダ `\\192.168.0.4\docker\` に `ondoku-demo` フォルダを作る
2. プログラムをNASへコピー（PowerShell。このリポジトリのフォルダで実行）
   ```powershell
   Copy-Item ondoku\Dockerfile,ondoku\server.js,ondoku\lib,ondoku\public "\\192.168.0.4\docker\ondoku-demo\" -Recurse -Force
   ```
3. メモ帳で `\\192.168.0.4\docker\ondoku-demo\ondoku.env` を作り、次の3行を書いて保存
   ```
   GEMINI_API_KEY=作った鍵
   ACCESS_CODE=生徒に伝える合言葉
   TRUST_PROXY=1
   ```
   - 合言葉を入れた人だけが「AI にくわしく見てもらう」を使えます（その場の判定は合言葉なしで使えます）。
   - AI の助言は、1つの接続元につき1時間30回までです。
4. NAS上でビルド・起動（パスワードを聞かれたら入力）
   ```powershell
   ssh -t -i C:\Users\griff010\.ssh\synology_griff takezawa@192.168.0.4 "cd /volume1/docker/ondoku-demo && sudo /usr/local/bin/docker build -t ondoku-demo . && sudo /usr/local/bin/docker run -d --name ondoku-demo --restart unless-stopped -p 127.0.0.1:3101:3100 --env-file /volume1/docker/ondoku-demo/ondoku.env ondoku-demo"
   ```
5. DSM → コントロールパネル → ログインポータル → 詳細設定 → リバースプロキシ → 作成
   - 名前 `ondoku-demo`
   - ソース：HTTPS／`ondoku.griff-juku.synology.me`／443
   - 宛先：HTTP／`127.0.0.1`／3101
6. スマホで https://ondoku.griff-juku.synology.me を開き、マイクを許可して試す

### 更新するとき
手順2でファイルを上書きしてから：
```powershell
ssh -t -i C:\Users\griff010\.ssh\synology_griff takezawa@192.168.0.4 "cd /volume1/docker/ondoku-demo && sudo /usr/local/bin/docker build -t ondoku-demo . && sudo /usr/local/bin/docker rm -f ondoku-demo && sudo /usr/local/bin/docker run -d --name ondoku-demo --restart unless-stopped -p 127.0.0.1:3101:3100 --env-file /volume1/docker/ondoku-demo/ondoku.env ondoku-demo"
```
鍵や合言葉を変えたときも、`ondoku.env` を書きかえてからこれを実行します。

### うまく動かないとき
- ログを見る：`sudo /usr/local/bin/docker logs --tail 20 ondoku-demo`
- 塾のLANからURLが開けないとき：スマホをWi-Fiから外す、またはPCの `hosts` に `192.168.0.4 ondoku.griff-juku.synology.me` を追加（下校時刻デモと同じ）
- iPhone の Safari：その場の判定は「設定 → Siri」がオフだと使えないことがあります。AI の助言は使えます。
- 止めるとき：`sudo /usr/local/bin/docker stop ondoku-demo` と、DSMのリバースプロキシ `ondoku-demo` を削除
