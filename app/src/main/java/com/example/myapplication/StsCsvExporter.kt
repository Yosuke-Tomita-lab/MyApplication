package com.example.myapplication

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.sqrt

object StsCsvExporter {

    fun generateCsv(result: StsAnalysisResult, selectedTrial: SingleTrialMetrics? = null): String {
        val sb = StringBuilder()
        val dateFormat = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
        val nowStr = dateFormat.format(Date())

        // 1. 全体メタ情報
        sb.appendLine("# STS Comprehensive Analysis Report (立ち座り動作解析 総合レポート)")
        sb.appendLine("Export Date,$nowStr")
        sb.appendLine("Analysis Mode,${result.mode.label}")
        sb.appendLine("Total Attempts (総試行数),${result.totalAttempts}")
        sb.appendLine("Successful Repetitions (成功数),${result.successCount}")
        sb.appendLine("Failed Attempts (離臀失敗数),${result.failureCount}")
        sb.appendLine("Success Rate (成功率),${String.format(Locale.US, "%.1f%%", result.successRatePercent)}")
        sb.appendLine("Failure Rate (失敗率),${String.format(Locale.US, "%.1f%%", result.failureRatePercent)}")
        if (selectedTrial != null) {
            sb.appendLine("Current Selected Repetition,${selectedTrial.repIndex}回目")
        }
        sb.appendLine("Subject Height (cm),${result.anthropometrics.heightCm}")
        sb.appendLine("Subject Weight (kg),${result.anthropometrics.weightKg}")
        sb.appendLine("Mirrored Video,${result.isFrontCameraMirrored}")
        if (result.mode == StsMode.THIRTY_SECONDS) {
            sb.appendLine("30s-STS Completed Reps in 30s (30秒間立ち上がり完了回数),${result.thirtySecCompletedCount}")
        }
        if (result.overallTotalDurationSec != null) {
            val label = if (result.mode == StsMode.THIRTY_SECONDS) "30s-STS Test Duration (s)" else "5xSTS Overall Total Duration (s)"
            sb.appendLine("$label,${String.format(Locale.US, "%.3f", result.overallTotalDurationSec)}")
        }
        sb.appendLine()

        // 2. 全試行サマリー一覧（各回および平均・標準偏差）
        val t0 = result.trials.firstOrNull()?.startTimeMs ?: 0L
        sb.appendLine("# All Repetitions Comparison Summary (各試行の指標比較一覧)")
        sb.appendLine("Rep,CumulativeTime_s,Start_s,SeatOff_s,StandEnd_s,Stable_s,TotalDuration_s,SeatOffDuration_s,RisingDuration_s,StabilizationDuration_s,MeanLeftBias_Pct,MeanRightBias_Pct,SeatOffLeftBias_Pct,SeatOffRightBias_Pct,PeakVertGRF_PctBW,PeakVertGRF_N,MinVertGRF_PctBW,MinVertGRF_N,PeakLatLeftGRF_PctBW,PeakLatLeftGRF_N,PeakLatRightGRF_PctBW,PeakLatRightGRF_N")

        result.trials.forEach { t ->
            val cumSec = (t.standEndTimeMs - t0) / 1000f
            sb.appendLine(
                listOf(
                    "${t.repIndex}回目",
                    String.format(Locale.US, "%.3f", cumSec),
                    String.format(Locale.US, "%.3f", t.startTimeMs / 1000f),
                    String.format(Locale.US, "%.3f", t.seatOffTimeMs / 1000f),
                    String.format(Locale.US, "%.3f", t.standEndTimeMs / 1000f),
                    String.format(Locale.US, "%.3f", t.stableTimeMs / 1000f),
                    String.format(Locale.US, "%.3f", t.totalDurationSec),
                    String.format(Locale.US, "%.3f", t.seatOffDurationSec),
                    String.format(Locale.US, "%.3f", t.risingDurationSec),
                    String.format(Locale.US, "%.3f", t.stabilizationDurationSec),
                    String.format(Locale.US, "%.1f", t.meanLeftBiasPercent),
                    String.format(Locale.US, "%.1f", 100f - t.meanLeftBiasPercent),
                    String.format(Locale.US, "%.1f", t.biasAtSeatOff.leftPercent),
                    String.format(Locale.US, "%.1f", t.biasAtSeatOff.rightPercent),
                    String.format(Locale.US, "%.1f", t.peakVerticalBwPercent),
                    String.format(Locale.US, "%.1f", t.peakVerticalNewton),
                    String.format(Locale.US, "%.1f", t.minVerticalBwPercent),
                    String.format(Locale.US, "%.1f", t.minVerticalNewton),
                    String.format(Locale.US, "%.1f", t.peakLateralLeftBwPercent),
                    String.format(Locale.US, "%.1f", t.peakLateralLeftNewton),
                    String.format(Locale.US, "%.1f", t.peakLateralRightBwPercent),
                    String.format(Locale.US, "%.1f", t.peakLateralRightNewton)
                ).joinToString(",")
            )
        }

        // 試行が2回以上ある場合は、平均値と標準偏差を出力
        if (result.trials.size >= 2) {
            val ts = result.trials
            fun avg(selector: (SingleTrialMetrics) -> Float) = String.format(Locale.US, "%.3f", ts.map(selector).average())
            fun avg1(selector: (SingleTrialMetrics) -> Float) = String.format(Locale.US, "%.1f", ts.map(selector).average())
            fun sd(selector: (SingleTrialMetrics) -> Float): String {
                val vals = ts.map(selector)
                val m = vals.average()
                val variance = vals.map { (it - m) * (it - m) }.average()
                return String.format(Locale.US, "%.3f", sqrt(variance))
            }
            fun sd1(selector: (SingleTrialMetrics) -> Float): String {
                val vals = ts.map(selector)
                val m = vals.average()
                val variance = vals.map { (it - m) * (it - m) }.average()
                return String.format(Locale.US, "%.1f", sqrt(variance))
            }

            sb.appendLine(
                listOf(
                    "平均値 (Average)",
                    "", "", "", "", "",
                    avg { it.totalDurationSec },
                    avg { it.seatOffDurationSec },
                    avg { it.risingDurationSec },
                    avg { it.stabilizationDurationSec },
                    avg1 { it.meanLeftBiasPercent },
                    avg1 { 100f - it.meanLeftBiasPercent },
                    avg1 { it.biasAtSeatOff.leftPercent },
                    avg1 { it.biasAtSeatOff.rightPercent },
                    avg1 { it.peakVerticalBwPercent },
                    avg1 { it.peakVerticalNewton },
                    avg1 { it.minVerticalBwPercent },
                    avg1 { it.minVerticalNewton },
                    avg1 { it.peakLateralLeftBwPercent },
                    avg1 { it.peakLateralLeftNewton },
                    avg1 { it.peakLateralRightBwPercent },
                    avg1 { it.peakLateralRightNewton }
                ).joinToString(",")
            )

            sb.appendLine(
                listOf(
                    "標準偏差 (StdDev)",
                    "", "", "", "", "",
                    sd { it.totalDurationSec },
                    sd { it.seatOffDurationSec },
                    sd { it.risingDurationSec },
                    sd { it.stabilizationDurationSec },
                    sd1 { it.meanLeftBiasPercent },
                    sd1 { 100f - it.meanLeftBiasPercent },
                    sd1 { it.biasAtSeatOff.leftPercent },
                    sd1 { it.biasAtSeatOff.rightPercent },
                    sd1 { it.peakVerticalBwPercent },
                    sd1 { it.peakVerticalNewton },
                    sd1 { it.minVerticalBwPercent },
                    sd1 { it.minVerticalNewton },
                    sd1 { it.peakLateralLeftBwPercent },
                    sd1 { it.peakLateralLeftNewton },
                    sd1 { it.peakLateralRightBwPercent },
                    sd1 { it.peakLateralRightNewton }
                ).joinToString(",")
            )
        }
        sb.appendLine()

        // 3. 各試行のイベント確定時刻と左右偏倚の詳細内訳
        sb.appendLine("# Event Timings & Weight-Bearing Bias Breakdown (各試行のイベント詳細・左右偏倚 - 50%正中)")
        sb.appendLine("Rep,Event,Timestamp_ms,Timestamp_s,Left_Bias_Pct,Right_Bias_Pct")
        result.trials.forEach { t ->
            val is30s = result.mode == StsMode.THIRTY_SECONDS
            val rep = "${t.repIndex}回目"
            sb.appendLine("$rep,Start (運動開始),${t.startTimeMs},${String.format(Locale.US, "%.3f", t.startTimeMs / 1000f)},${String.format(Locale.US, "%.1f", t.biasAtStart.leftPercent)},${String.format(Locale.US, "%.1f", t.biasAtStart.rightPercent)}")
            sb.appendLine("$rep,Seat-off (離臀),${t.seatOffTimeMs},${String.format(Locale.US, "%.3f", t.seatOffTimeMs / 1000f)},${String.format(Locale.US, "%.1f", t.biasAtSeatOff.leftPercent)},${String.format(Locale.US, "%.1f", t.biasAtSeatOff.rightPercent)}")
            val endLabel = if (is30s) "End (終了)" else "Stand-end (立ち上がり完了)"
            sb.appendLine("$rep,$endLabel,${t.standEndTimeMs},${String.format(Locale.US, "%.3f", t.standEndTimeMs / 1000f)},${String.format(Locale.US, "%.1f", t.biasAtStandEnd.leftPercent)},${String.format(Locale.US, "%.1f", t.biasAtStandEnd.rightPercent)}")
            if (!is30s) {
                sb.appendLine("$rep,Stable (立位安定),${t.stableTimeMs},${String.format(Locale.US, "%.3f", t.stableTimeMs / 1000f)},${String.format(Locale.US, "%.1f", t.biasAtStable.leftPercent)},${String.format(Locale.US, "%.1f", t.biasAtStable.rightPercent)}")
            }
        }
        sb.appendLine()

        // 4. 離臀失敗イベント詳細（存在する場合）
        if (result.failedAttempts.isNotEmpty()) {
            sb.appendLine("# Failed Seat-off Attempts (離臀失敗イベント一覧)")
            sb.appendLine("Failure_Index,Timestamp_ms,Timestamp_s,Note")
            result.failedAttempts.forEachIndexed { i, fa ->
                sb.appendLine("${i + 1},${fa.timestampMs},${String.format(Locale.US, "%.3f", fa.timestampMs / 1000f)},${fa.note}")
            }
            sb.appendLine()
        }

        // 5. 全フレーム連続時系列データ（各回・フェーズ・失敗試行のラベリング付き）
        sb.appendLine("# Continuous Time-Series Frame Data (全フレーム連続時系列データ)")
        sb.appendLine("Frame_Index,Timestamp_ms,Timestamp_s,Active_Rep,Phase,CoM_X,CoM_Y,MidBase_X,Base_Width,Left_Bias_Pct,Right_Bias_Pct,Vertical_GRF_PctBW,Vertical_GRF_N,Lateral_GRF_PctBW,Lateral_GRF_N,Shoulder_L_X,Shoulder_L_Y,Shoulder_R_X,Shoulder_R_Y,Hip_L_X,Hip_L_Y,Hip_R_X,Hip_R_Y,Knee_L_X,Knee_L_Y,Knee_R_X,Knee_R_Y,Ankle_L_X,Ankle_L_Y,Ankle_R_X,Ankle_R_Y")

        result.frames.forEachIndexed { idx, f ->
            val (repLabel, phaseLabel) = resolveRepAndPhase(f.timestampMs, result.trials, result.failedAttempts)

            val vBw = f.grf?.verticalPercentBw?.let { String.format(Locale.US, "%.2f", it) } ?: ""
            val vN = f.grf?.verticalNewton?.let { String.format(Locale.US, "%.2f", it) } ?: ""
            val lBw = f.grf?.lateralPercentBw?.let { String.format(Locale.US, "%.2f", it) } ?: ""
            val lN = f.grf?.lateralNewton?.let { String.format(Locale.US, "%.2f", it) } ?: ""

            val lm = f.landmarks
            fun pStr(pt: Point2D?) = pt?.let { "${String.format(Locale.US, "%.4f", it.x)},${String.format(Locale.US, "%.4f", it.y)}" } ?: ","

            val row = listOf(
                idx.toString(),
                f.timestampMs.toString(),
                String.format(Locale.US, "%.3f", f.timestampMs / 1000f),
                repLabel,
                phaseLabel,
                String.format(Locale.US, "%.4f", f.comX),
                String.format(Locale.US, "%.4f", f.comY),
                String.format(Locale.US, "%.4f", f.midBaseX),
                String.format(Locale.US, "%.4f", f.baseWidth),
                String.format(Locale.US, "%.2f", f.leftBiasPercent),
                String.format(Locale.US, "%.2f", f.rightBiasPercent),
                vBw,
                vN,
                lBw,
                lN,
                pStr(lm[11]),
                pStr(lm[12]),
                pStr(lm[23]),
                pStr(lm[24]),
                pStr(lm[25]),
                pStr(lm[26]),
                pStr(lm[27]),
                pStr(lm[28])
            ).joinToString(",")

            sb.appendLine(row)
        }

        return sb.toString()
    }

    private fun resolveRepAndPhase(
        timestampMs: Long,
        trials: List<SingleTrialMetrics>,
        failedAttempts: List<FailedAttempt>
    ): Pair<String, String> {
        // 離臀失敗イベントの近傍（±250ms）かどうかを判定
        val matchedFail = failedAttempts.firstOrNull { kotlin.math.abs(it.timestampMs - timestampMs) <= 250L }
        val failSuffix = if (matchedFail != null) " [離臀失敗発生]" else ""

        if (trials.isEmpty()) return "なし" to ("待機" + failSuffix)

        // 該当する試行を探す
        for (t in trials) {
            if (timestampMs >= t.startTimeMs && timestampMs <= t.stableTimeMs) {
                val phase = when {
                    timestampMs < t.seatOffTimeMs -> "フェーズ1: 開始〜離臀前"
                    timestampMs < t.standEndTimeMs -> "フェーズ2: 立ち上がり中"
                    timestampMs < t.stableTimeMs -> "フェーズ3: 立位安定化中"
                    else -> "フェーズ4: 立位安定"
                }
                return "${t.repIndex}回目" to (phase + failSuffix)
            }
        }

        val firstStart = trials.first().startTimeMs
        val lastStable = trials.last().stableTimeMs
        return when {
            timestampMs < firstStart -> "待機" to ("開始前・座位" + failSuffix)
            timestampMs > lastStable -> "完了" to ("全試行終了後" + failSuffix)
            else -> "インターバル" to ("着座・試行間" + failSuffix)
        }
    }

    // Excel等で日本語が文字化けしないようにUTF-8 BOMを付与
    private val UTF8_BOM = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())

    fun saveCsvToUri(context: Context, uri: Uri, content: String): Boolean {
        return try {
            context.contentResolver.openOutputStream(uri)?.use { out ->
                out.write(UTF8_BOM)
                out.write(content.toByteArray(Charsets.UTF_8))
                out.flush()
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    fun shareCsv(context: Context, filename: String, content: String) {
        try {
            val cacheDir = File(context.cacheDir, "csv_exports")
            if (!cacheDir.exists()) cacheDir.mkdirs()
            val file = File(cacheDir, filename)
            FileOutputStream(file).use { out ->
                out.write(UTF8_BOM)
                out.write(content.toByteArray(Charsets.UTF_8))
                out.flush()
            }

            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file
            )

            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "text/csv"
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, "STS Analysis Report: $filename")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(Intent.createChooser(intent, "CSVを出力・共有"))
        } catch (e: Exception) {
            val fallbackIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, content)
                putExtra(Intent.EXTRA_SUBJECT, "STS Analysis Report: $filename")
            }
            context.startActivity(Intent.createChooser(fallbackIntent, "CSVを出力・共有"))
        }
    }
}
