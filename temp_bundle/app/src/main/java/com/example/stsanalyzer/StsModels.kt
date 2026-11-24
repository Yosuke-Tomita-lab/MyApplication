package com.example.stsanalyzer

enum class StsMode(val label: String, val targetReps: Int) {
    SINGLE("単回立ち座り", 1),
    FIVE_TIMES("5回立ち座り (5xSTS)", 5)
}

data class Point2D(
    val x: Float, // 正規化座標 [0.0, 1.0]（画面左が0、右が1）
    val y: Float  // 正規化座標 [0.0, 1.0]（画面上が0、下が1）
)

data class PoseFrameData(
    val timestampMs: Long,
    val landmarks: Map<Int, Point2D>, // MediaPipe Pose index -> Point2D
    val comX: Float,                  // 推定CoMのX座標
    val midBaseX: Float,              // 支持基底面（両足）正中X座標
    val baseWidth: Float,             // 支持基底面（両足）幅（最小ガードレール適用後）
    val leftBiasPercent: Float,       // 解剖学的「左」偏倚率（50.0%が正中）
    val rightBiasPercent: Float       // 解剖学的「右」偏倚率（100 - leftBiasPercent）
)

data class TimingBias(
    val timestampMs: Long,
    val leftPercent: Float,
    val rightPercent: Float
)

data class SingleTrialMetrics(
    val repIndex: Int,
    val startTimeMs: Long,
    val seatOffTimeMs: Long,
    val standEndTimeMs: Long,
    val stableTimeMs: Long,
    val totalDurationSec: Float,         // 総運動時間（開始〜安定）
    val seatOffDurationSec: Float,       // 離臀時間（開始〜離臀）
    val risingDurationSec: Float,        // 立ち上がり時間（離臀〜立位完了）
    val stabilizationDurationSec: Float, // 立位安定時間（立位完了〜安定）
    val biasAtStart: TimingBias,
    val biasAtSeatOff: TimingBias,
    val biasAtStandEnd: TimingBias,
    val biasAtStable: TimingBias,
    val meanLeftBiasPercent: Float       // 当該試行の平均左偏倚%
)

data class StsAnalysisResult(
    val mode: StsMode,
    val trials: List<SingleTrialMetrics>,
    val overallTotalDurationSec: Float?, // 5xSTSの1回目開始〜5回目安定までの総時間
    val frames: List<PoseFrameData>,
    val isFrontCameraMirrored: Boolean = false
)
