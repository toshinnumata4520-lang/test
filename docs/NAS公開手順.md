# NAS公開手順（デモ用）

社内NAS（Synology DS920+、LAN内 192.168.0.4）に、時間割システムと同じ方法（Docker＋DSMのリバースプロキシ）でデモ公開した手順です。

## 公開先
- URL：**https://gekou.griff-juku.synology.me**
- 証明書：既存の `*.griff-juku.synology.me`（ワイルドカード）をそのまま使用。ルーターの設定変更は不要（80/443は開放済み）
- デモのログイン：ログイン画面のデモ用ボタン（パスワードはすべて `demo1234`）

## 構成
| 項目 | 内容 |
|---|---|
| 置き場所 | `/volume1/docker/gekou-demo/`（共有フォルダ `\\192.168.0.4\docker\gekou-demo`） |
| データ | `/volume1/docker/gekou-demo/data/db.json`（コンテナの `/app/data` にマウント。消えない） |
| コンテナ名 | `gekou-demo`（`--restart unless-stopped`） |
| ポート | NAS内の `127.0.0.1:3100` → コンテナ `3000`（LANからは直接見えない） |
| 環境変数 | `SECURE_COOKIE=1` / `TRUST_PROXY=1` / `PUSH_SUBJECT=mailto:toshin.numata4520@gmail.com` |
| 時間割システム | 別コンテナ（ポート8811）。影響なし |

## 手順
1. プログラムをNASへコピー（PowerShell。このリポジトリのフォルダで実行）
   ```powershell
   Copy-Item Dockerfile,package.json,server.js,lib,public "\\192.168.0.4\docker\gekou-demo\" -Recurse -Force
   ```
2. NAS上でビルド・起動（パスワードを聞かれたら入力）
   ```powershell
   ssh -t -i C:\Users\griff010\.ssh\synology_griff takezawa@192.168.0.4 "cd /volume1/docker/gekou-demo && chmod 777 data && sudo /usr/local/bin/docker build -t gekou-demo . && sudo /usr/local/bin/docker run -d --name gekou-demo --restart unless-stopped -p 127.0.0.1:3100:3000 -v /volume1/docker/gekou-demo/data:/app/data -e SECURE_COOKIE=1 -e TRUST_PROXY=1 -e PUSH_SUBJECT=mailto:toshin.numata4520@gmail.com gekou-demo"
   ```
   ※ SynologyではsudoのPATHにdockerが無いので `/usr/local/bin/docker` とフルパスで書く。
3. DSM → コントロールパネル → ログインポータル → 詳細設定 → リバースプロキシ → 作成
   - 名前 `gekou-demo`
   - ソース：HTTPS／`gekou.griff-juku.synology.me`／443
   - 宛先：HTTP／`127.0.0.1`／3100

## 更新するとき
1の手順でファイルを上書きしてから：
```powershell
ssh -t -i C:\Users\griff010\.ssh\synology_griff takezawa@192.168.0.4 "cd /volume1/docker/gekou-demo && sudo /usr/local/bin/docker build -t gekou-demo . && sudo /usr/local/bin/docker rm -f gekou-demo && sudo /usr/local/bin/docker run -d --name gekou-demo --restart unless-stopped -p 127.0.0.1:3100:3000 -v /volume1/docker/gekou-demo/data:/app/data -e SECURE_COOKIE=1 -e TRUST_PROXY=1 -e PUSH_SUBJECT=mailto:toshin.numata4520@gmail.com gekou-demo"
```
データ（`data/db.json`）は残ります。デモデータを作り直したいときは `data/db.json` を削除してから再起動。

## 注意
- 社内のPC（塾のLAN）からは、ルーターの都合でこのURLが開けないことがあります（外からは開ける）。その場合はスマホをWi-Fiから外して開くか、PCの `hosts` に `192.168.0.4 gekou.griff-juku.synology.me` を追加する。
- サンプルデータのみ。実際の学校・児童のデータは入れない（本番は教育委員会側のサーバーへ移す方針）。
- 止めるとき：`sudo /usr/local/bin/docker stop gekou-demo` と、DSMのリバースプロキシ `gekou-demo` を削除。
