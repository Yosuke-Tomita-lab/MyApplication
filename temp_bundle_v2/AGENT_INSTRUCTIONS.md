# Android Studio Agent 向け実装仕様書：立ち座り動作解析アプリ（推定床反力・身長体重入力対応版）

## 1. プロジェクト前提・環境ルール
- 対象プロジェクトパッケージは `com.example.myapplication`（`app/src/main/java/com/example/myapplication/`）に統一すること。
- すべてのソースコード・リソース・Markdown ファイルは **UTF-8（BOMなし）** で作成・保存し、エンコーディング誤認識による文字化け・構文エラーを防ぐこと。
- 動画解析はリアルタイム処理ではなく、**撮影または既存動画選択後のオフライン一括処理（`MediaExtractor` + `MediaCodec` + MediaPipe Pose Landmarker `RunningMode.VIDEO`）** で実装すること。
- 撮影アングルは **正面からの全身撮影** を前提とし、左右重心偏倚は **身体基準（両足部中点を正中50%とし、両足幅を基準幅、過度に狭い場合は骨盤幅×0.8または0.06を最小ガードレールとする）** で算出すること。

---

## 2. 対応モードと算出指標

### モード
- **単回立ち座り (`SINGLE`)**: 1試行の立ち上がり動作を解析
- **5回立ち座り (`FIVE_TIMES` / 5xSTS)**: 5回連続立ち座り動作を解析し、全体所要時間および1〜5回目の個別内訳を比較表示

### 時間パラメータ（4指標・秒）
1. **総運動時間**: 運動開始（体幹前傾開始または股関節上昇開始）〜立位安定まで
2. **離臀時間**: 運動開始〜離臀（臀部が座面から離れ上方移動を開始）まで
3. **立ち上がり時間**: 離臀〜立ち上がり完了（立位高さ到達）まで
4. **立位安定時間**: 立ち上がり完了〜立位安定（左右偏倚変動幅が閾値内に収束）まで

### 平均重心位置の左右偏倚（%）
- 50% を正中とし、解剖学的左右（被験者自身の左・右）で `左 XX.X% / 右 YY.Y%` と表示する（鏡像反転チェックボックス対応）。
- 運動開始時・離臀時・立ち上がり完了時・立位安定時・試行平均を算出する。

### 被験者入力（身長・体重）と推定床反力（%BW / N 併記）
- 画面上で **身長（cm）** と **体重（kg）** を入力できるようにする（デフォルト：身長 `170` cm、体重 `65` kg）。
- 立位時の頭頂〜足底の正規化高さと入力身長から `metersPerNormUnit` を求め、平滑化した推定身体重心（CoM）位置の二階微分から水平・鉛直加速度（m/s^2）を算出する。
- 入力体重 m (kg) と重力加速度 g = 9.80665 m/s^2 を用い、主に離臀〜立位安定区間を中心に以下の推定床反力を **`%BW` と `N` の両方** で表示する：
  - **鉛直GRF ピーク（加速）**: `%BW` / `N`
  - **鉛直GRF 最小（減速・抜重）**: `%BW` / `N`
  - **左右GRF ピーク（左方向）**: `%BW` / `N`
  - **左右GRF ピーク（右方向）**: `%BW` / `N`

---

## 3. 同梱ファイル一覧
1. `app/build.gradle.kts`
2. `app/src/main/AndroidManifest.xml`
3. `app/src/main/java/com/example/myapplication/StsModels.kt`
4. `app/src/main/java/com/example/myapplication/VideoPoseExtractor.kt`
5. `app/src/main/java/com/example/myapplication/StsMetricCalculator.kt`
6. `app/src/main/java/com/example/myapplication/PoseEventOverlayView.kt`
7. `app/src/main/java/com/example/myapplication/StsCameraCaptureScreen.kt`
8. `app/src/main/java/com/example/myapplication/MainActivity.kt`

※ `app/src/main/assets/pose_landmarker_full.task`（または `pose_landmarker_lite.task`）を配置してビルド検証を行うこと。
