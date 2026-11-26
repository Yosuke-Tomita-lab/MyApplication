# STS Biomechanical Web Analyzer (立ち座り生体力学解析 Webアプリ)

ブラウザ（PC / Mac / iPad / iPhone / Android）で動作する、クライアント完結型の立ち座り動作（Sit-to-Stand: STS）生体力学解析Webアプリケーションです。

---

## 🌟 特徴・機能

1. **完全クライアントサイド実行 (Privacy-First)**:
   - 動画ファイルやカメラ映像は**外部サーバーへ一切送信されず**、ブラウザ内（MediaPipe Web + WebGL）で高速処理されます。患者・被験者の個人情報保護や医療倫理審査（IRB）にも適合します。
2. **3つの計測モード**:
   - **通常立ち上がり (Single STS)**: 1回の詳細フェーズ解析。
   - **5回立ち座り (5STS)**: 全5回のトータル所要時間、試行間の離臀失敗の検出・複数記録、成功率・失敗率。
   - **30秒立ち座り (30s-STS)**: 動画確認後の総数入力・補正、3イベント（開始・離臀・終了）特化、**第1回開始から30秒を超過した試行の自動除外**。
3. **生体力学推計**:
   - 身体重心（CoM）、左右荷重偏倚率（Left Bias %: 50%正中基準）、推定床反力（鉛直・左右制動力 %BW, N）。
4. **インタラクティブUI & グラフ**:
   - 動画再生・シークバー・骨格/CoMオーバーレイ描画。
   - 各回累積時間＆立ち上がり時間グラフ（Chart.js）。
   - 重心左右偏倚グラフ（50%正中基準、青:左 / 橙:右、離臀時偏倚◆マーカー）。
   - 各イベントタイミング（開始・離臀・終了・安定）のスライダー微調整。
5. **CSVエクスポート**:
   - UTF-8（BOM付き）で全サマリー、各試行メトリクス、全フレーム時系列データをワンクリック保存。

---

## 🚀 使い方・ローカル起動方法

Node.js や npm のインストールは**不要**です。モダンブラウザがあればどこでも動作します。

### 方法1: ローカルサーバーで起動（推奨）
ブラウザのセキュリティ（ES ModulesのCORS制限）上、ローカルの静的Webサーバー経由で開くのが推奨されます。

#### Python をお持ちの場合:
```bash
cd web
python -m http.server 8080
```
ブラウザで `http://localhost:8080` を開きます。

#### VS Code をお使いの場合:
- 拡張機能「Live Server」をインストールし、`web/index.html` を右クリックして「Open with Live Server」を選択。

---

## 🌐 Web（GitHub Pages / Vercel）での無料公開手順

### 1. GitHub Pages で公開する場合（最も簡単）
1. 本リポジトリの `main` ブランチに push します。
2. GitHub のリポジトリページを開き、**Settings** > **Pages** に移動します。
3. **Build and deployment** の Source で **Deploy from a branch** を選択。
4. Branch を `main`、フォルダを `/web` に設定して **Save** をクリック。
5. 数分で `https://<ユーザー名>.github.io/<リポジトリ名>/` にWebアプリが公開されます！

### 2. Vercel / Cloudflare Pages で公開する場合
1. Vercel または Cloudflare Pages に本リポジトリを連携。
2. Root Directory を `web` に指定してデプロイ。
3. 即座にカスタムドメイン付きのHTTPSサイトとして全世界に公開されます。

---

## 🧍 高精度メッシュ解析（InstantHMR）

STEP 2 の「解析エンジン」で **高精度メッシュ（InstantHMR）** を選ぶと、MediaPipe の代わりに
[InstantHMR](https://huggingface.co/momolesang/InstantHMR) で人体メッシュ（Meta MHR、18,439頂点）と関節を推定します。
推定は**ブラウザ内だけ**で行い、動画は外部に送信されません。

- **実行方式**: WebGPU が使える端末では GPU、使えない端末では CPU（WASM）で動きます。
- **モデル**: 初回のみ約145MBを [Hugging Face (yomita/instanthmr-web)](https://huggingface.co/yomita/instanthmr-web) から読み込み、以降はブラウザのキャッシュを使います。
  ブラウザ向けの変換は `scripts/convert_instanthmr_web.py` で再現できます。
- **出力**: 関節は MediaPipe Pose と同じ33点の番号に変換されるため、イベント検出・グラフ・CSV出力はそのまま使えます。3D表示では「人体メッシュ」で骨格表示と切り替えられます。
- **ライセンス**: 重みは [SAM License](licenses/LICENSE-SAM.txt)。`medium` モデルは学習画像の条件により**非商用利用のみ**です。体モデル MHR は [Apache-2.0](licenses/LICENSE-MHR-Apache-2.0.txt)。
- **注意**: 正面から撮影した動画では、前後方向（奥行き）の値は単眼推定のため誤差が大きくなります。矢状面の指標は側方からの撮影を推奨します。
