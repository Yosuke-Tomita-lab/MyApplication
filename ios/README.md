# iPad Pro LiDAR ✕ STS Biomechanical Analyzer (iOS Native App)

iPad Pro（第4世代など LiDAR 搭載機）の背面カメラと LiDAR センサー（赤外線 dToF）を活用し、**「アプリ画面の撮影ボタンを1タップするだけ」で動画撮影・LiDAR実測深度測定・3D生体力学解析・PDFレポート生成を一括で完結**させる専用 iOS アプリです。

---

## 🎯 主な機能と特徴

1. **ワンタップ一括測定（ゼロ手間）**:
   - 外部アプリ（Record3Dなど）での録画や、ファイルのエクスポート/インポートが一切不要。
   - 「● 測定開始」を押して立ち座り動作を行うだけで、終了時にミリ精度で自動解析が走ります。
2. **Apple ARKit ✕ LiDAR 深度フュージョン**:
   - `ARBodyTrackingConfiguration`（人体の3D骨格追跡）と `SceneDepth`（LiDAR実測深度マップ）を 60fps で完全同期収集。
   - 単眼カメラ推定の最大の弱点である前後方向（Z軸）の推測誤差が、**LiDAR のミリ単位実測距離**によって完全に解消されます。
3. **完成済みの高精度生体力学エンジンをフル内蔵**:
   - **3D生体力学メッシュビューア**（足首接地固定 ＋ 剛体骨長保存）
   - **矢状面 CoM 3D軌跡 & 前後床反力（AP-GRF: 加速/制動%BW）**
   - **Angle-Angle Diagram（膝屈曲角 vs 股関節屈曲角）の各試行＆重ね描き**
   - **A4横長/縦長 PDFレポート生成 ＆ AirPrint 印刷・PDF保存**

---

## 📂 プロジェクト構成

```
ios/
├── STSAnalyzer/
│   ├── App/
│   │   └── STSAnalyzerApp.swift      # SwiftUI エントリポイント
│   ├── Views/
│   │   ├── MainContentView.swift     # 撮影画面と解析画面のシームレス切り替え
│   │   ├── ARCaptureView.swift       # ARKit+LiDARカメラプレビュー・全身ガイド枠・測定UI
│   │   └── AnalysisWebView.swift     # 解析結果・3Dビューア・AirPrint印刷UI
│   ├── Services/
│   │   └── ARKitManager.swift        # LiDAR深度+3D骨格関節の同期記録エンジン
│   ├── Web/                          # 内蔵生体力学エンジン（HTML5/Three.js/Chart.js一式）
│   │   ├── index.html
│   │   ├── sts3dViewer.js
│   │   ├── stsMetrics.js
│   │   ├── stsModels.js
│   │   └── stsExporter.js
│   └── Info.plist                    # カメラ権限・ARKit設定
└── README.md                         # 本ガイド
```

---

## 🚀 Xcode でのビルド＆iPad Proへの実機転送手順（約5分）

無料の Apple ID（開発者登録不要）があれば、お持ちの Mac と iPad Pro をケーブルで繋ぐだけで実機にアプリをインストールできます。

### ステップ 1: Xcode で新規プロジェクト作成
1. Mac で **Xcode** を起動し、**「Create New Project...」** を選択。
2. **「iOS」** タブ ➜ **「App」** を選択して「Next」。
3. 設定項目を入力：
   - **Product Name**: `STSAnalyzer`
   - **Team**: ご自身の Apple ID（Personal Team）を選択
   - **Interface**: `SwiftUI`
   - **Language**: `Swift`
4. 保存先として本リポジトリの `ios/` 付近を選択して作成。

### ステップ 2: ソースコードの追加
1. 自動生成された `ContentView.swift` や `STSAnalyzerApp.swift` を削除。
2. 本フォルダ内の `STSAnalyzer/` にあるフォルダ群：
   - `App/`
   - `Views/`
   - `Services/`
   - `Web/`
   を、Xcode の左側プロジェクトナビゲータに**ドラッグ＆ドロップ**。
   - ※「Destination: Copy items if needed」にチェックを入れて追加してください。
3. `Info.plist` の `NSCameraUsageDescription`（カメラ使用許可メッセージ）を確認。

### ステップ 3: iPad Pro を接続して実行
1. iPad Pro（第4世代）を Mac に USB-C ケーブルで接続。
2. Xcode 上部の実行ターゲット（デバイス選択）で、ご自身の **「iPad Pro」** を選択。
3. 画面左上の **「▶（Run）」** ボタンをクリック。
4. iPad 側で初回のみ「設定」➜「一般」➜「VPNとデバイス管理」からご自身の開発元を「信頼」に設定。
5. iPad 上でアプリが起動し、ワンタップでの LiDAR ✕ 3D生体力学一括測定が利用可能になります！
