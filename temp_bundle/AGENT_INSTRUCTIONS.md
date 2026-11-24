# Android Studio Agent 向け実装仕様書：立ち座り動作解析アプリ (STS Analyzer)

## 1. 概要
正面からの全身動画（新規撮影または既存MP4選択）を対象に、オフライン（撮影後バッチ処理）で MediaPipe Pose Landmarker による2D骨格検知を行い、以下の変数および左右重心偏倚を算出・表示するAndroidアプリ（Kotlin + Jetpack Compose）を実装する。

### モード対応
- **単回立ち座り (SINGLE)**: 1試行の立ち上がり動作を解析
- **5回立ち座り (FIVE_TIMES / 5xSTS)**: 5回連続立ち座り動作を解析し、全体所要時間および1〜5回目の個別内訳を比較表示

### 算出指標
1. **総運動時間（秒）**: 運動開始（体幹前傾開始または股関節上昇開始）〜立位安定まで
2. **離臀時間（秒）**: 運動開始〜離臀（臀部が座面から離れ上方移動を開始）まで
3. **立ち上がり時間（秒）**: 離臀〜立ち上がり完了（立位高さ到達）まで
4. **立位安定時間（秒）**: 立ち上がり完了〜立位安定（左右偏倚変動幅が閾値内に収束）まで
5. **平均重心位置の左右偏倚（%）**:
   - 身体基準（両足部中心を正中50%とし、両足幅を基準幅、過度に狭い場合は骨盤幅×0.8を最小ガードレールとする）で算出
   - 例: 左 60.0% / 右 40.0%（解剖学的左右で統一。鏡像反転オプションあり）
   - 運動開始時・離臀時・立ち上がり完了時・立位安定時・試行平均を提示

---

## 2. セットアップ手順（Agent実行タスク）
1. `app/build.gradle.kts` に記載の依存関係（Compose, MediaPipe `tasks-vision:0.10.14`, CameraX `1.4.1`, Coroutines）をプロジェクトの `app/build.gradle.kts` に統合する。
2. `AndroidManifest.xml` に `CAMERA` および `RECORD_AUDIO` 権限を追加する。
3. MediaPipe 公式モデル `pose_landmarker_full.task`（または `pose_landmarker_lite.task`）をダウンロードし、`app/src/main/assets/pose_landmarker_full.task` に配置する。
4. `app/src/main/java/com/example/stsanalyzer/` 配下の全 Kotlin ファイルをパッケージ名に合わせて配置・ビルド検証を行う。
   - `StsModels.kt`: データモデル定義
   - `VideoPoseExtractor.kt`: `MediaExtractor` + `MediaCodec` + MediaPipe `PoseLandmarker` によるオフライン全フレーム骨格・重心偏倚抽出
   - `StsMetricCalculator.kt`: 欠損補間・移動平均・4イベント検出・5xSTS反復検出・手動タイムスタンプ再計算エンジン
   - `PoseEventOverlayView.kt`: 骨格・支持基底面・推定重心（CoM）キャンバス描画＆イベント時刻手動微調整UI
   - `StsCameraCaptureScreen.kt`: CameraX 正面全身ガイド枠付き動画撮影画面
   - `MainActivity.kt`: モード切替・動画撮影/選択・解析プログレス・結果サマリー画面
