package com.example.myapplication

import android.graphics.Bitmap
import android.net.Uri

enum class StsMode(val label: String, val targetReps: Int) {
    SINGLE("単回立ち座り", 1),
    FIVE_TIMES("5回立ち座り (5xSTS)", 5)
}

data class SubjectAnthropometrics(
    val heightCm: Float = 170f,
    val weightKg: Float = 65f
)

data class Point2D(
    val x: Float, // 正規化座標 [0.0, 1.0]（画面左が0、右が1）
    val y: Float  // 正規化座標 [0.0, 1.0]（画面上が0、下が1）
)

data class GrfSample(
    val verticalPercentBw: Float, // 鉛直GRF（静止立位=100%BW）
    val verticalNewton: Float,    // 鉛直GRF（N）
    val lateralPercentBw: Float,  // 左右GRF（%BW、正値=解剖学的左方向、負値=右方向）
    val lateralNewton: Float      // 左右GRF（N）
)

data class PoseFrameData(
    val timestampMs: Long,
    val landmarks: Map<Int, Point2D>, // MediaPipe Pose index -> Point2D
    val comX: Float,                  // 推定CoMのX座標
    val comY: Float = 0.5f,           // 推定CoMのY座標
    val midBaseX: Float,              // 支持基底面（両足）正中X座標
    val baseWidth: Float,             // 支持基底面（両足）幅（最小ガードレール適用後）
    val leftBiasPercent: Float,       // 解剖学的「左」偏倚率（50.0%が正中）
    val rightBiasPercent: Float,      // 解剖学的「右」偏倚率（100 - leftBiasPercent）
    val grf: GrfSample? = null,       // 推定床反力サンプル
    val previewBitmap: Bitmap? = null // 同一フレームの実動画プレビュー画像
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
    val meanLeftBiasPercent: Float,      // 当該試行の平均左偏倚%
    val peakVerticalBwPercent: Float,
    val peakVerticalNewton: Float,
    val minVerticalBwPercent: Float,
    val minVerticalNewton: Float,
    val peakLateralLeftBwPercent: Float,
    val peakLateralLeftNewton: Float,
    val peakLateralRightBwPercent: Float,
    val peakLateralRightNewton: Float
)

data class FailedAttempt(
    val timestampMs: Long,
    val note: String = "離臀失敗"
)

data class StsAnalysisResult(
    val mode: StsMode,
    val anthropometrics: SubjectAnthropometrics,
    val trials: List<SingleTrialMetrics>,
    val overallTotalDurationSec: Float?, // 5xSTSの1回目開始〜5回目安定までの総時間
    val frames: List<PoseFrameData>,
    val isFrontCameraMirrored: Boolean = false,
    val videoUri: Uri? = null,
    val failedAttempts: List<FailedAttempt> = emptyList()
) {
    val successCount: Int get() = trials.size
    val failureCount: Int get() = failedAttempts.size
    val totalAttempts: Int get() = successCount + failureCount
    val successRatePercent: Float get() = if (totalAttempts > 0) (successCount.toFloat() / totalAttempts) * 100f else 0f
    val failureRatePercent: Float get() = if (totalAttempts > 0) (failureCount.toFloat() / totalAttempts) * 100f else 0f
}
