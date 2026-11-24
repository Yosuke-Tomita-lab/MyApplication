package com.example.myapplication

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

private val SKELETON_CONNECTIONS = listOf(
    11 to 12,
    11 to 23, 12 to 24,
    23 to 24,
    23 to 25, 25 to 27,
    24 to 26, 26 to 28
)

class VideoFrameProvider(private val context: Context, private val videoUri: Uri?) {
    private var retriever: MediaMetadataRetriever? = null
    private val cache = object : LruCache<Long, Bitmap>(35) {}

    init {
        if (videoUri != null) {
            try {
                retriever = MediaMetadataRetriever().apply {
                    setDataSource(context, videoUri)
                }
            } catch (_: Exception) {
            }
        }
    }

    fun getFrame(timestampMs: Long): Bitmap? {
        val cached = cache.get(timestampMs)
        if (cached != null) return cached

        val r = retriever ?: return null
        return try {
            val timeUs = timestampMs * 1000L
            val bmp = r.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST)
            if (bmp != null) {
                cache.put(timestampMs, bmp)
            }
            bmp
        } catch (_: Exception) {
            null
        }
    }

    fun release() {
        try {
            retriever?.release()
        } catch (_: Exception) {
        }
        retriever = null
        cache.evictAll()
    }
}

@Composable
fun PoseEventOverlayCard(
    frames: List<PoseFrameData>,
    trial: SingleTrialMetrics,
    videoUri: Uri? = null,
    analysisResult: StsAnalysisResult? = null,
    onTrialUpdated: (SingleTrialMetrics) -> Unit,
    onFailedAttemptsUpdated: ((List<FailedAttempt>) -> Unit)? = null,
    onRequestSaveCsv: ((filename: String, content: String) -> Unit)? = null
) {
    if (frames.isEmpty()) return

    val context = LocalContext.current

    val frameProvider = remember(videoUri) {
        VideoFrameProvider(context, videoUri)
    }

    DisposableEffect(frameProvider) {
        onDispose {
            frameProvider.release()
        }
    }

    var frameIndex by remember(trial.repIndex) {
        mutableIntStateOf(
            frames.indexOfFirst { it.timestampMs >= trial.startTimeMs }.coerceAtLeast(0)
        )
    }

    // ドラフト状態のイベント時刻
    var startMs by remember(trial.repIndex, trial.startTimeMs) { mutableLongStateOf(trial.startTimeMs) }
    var seatOffMs by remember(trial.repIndex, trial.seatOffTimeMs) { mutableLongStateOf(trial.seatOffTimeMs) }
    var standEndMs by remember(trial.repIndex, trial.standEndTimeMs) { mutableLongStateOf(trial.standEndTimeMs) }
    var stableMs by remember(trial.repIndex, trial.stableTimeMs) { mutableLongStateOf(trial.stableTimeMs) }

    var reanalyzeNotice by remember { mutableStateOf<String?>(null) }

    val hasPendingChanges = (startMs != trial.startTimeMs) ||
            (seatOffMs != trial.seatOffTimeMs) ||
            (standEndMs != trial.standEndTimeMs) ||
            (stableMs != trial.stableTimeMs)

    val currentFrame = frames[frameIndex.coerceIn(0, frames.lastIndex)]
    val currentMs = currentFrame.timestampMs
    val minMs = frames.first().timestampMs
    val maxMs = frames.last().timestampMs

    // 現在フレームの動画ビットマップを非同期取得
    var videoFrameBitmap by remember { mutableStateOf<Bitmap?>(null) }
    LaunchedEffect(frameProvider, currentMs) {
        withContext(Dispatchers.IO) {
            val bmp = frameProvider.getFrame(currentMs)
            withContext(Dispatchers.Main) {
                videoFrameBitmap = bmp
            }
        }
    }

    val phaseLabel = when {
        currentMs < startMs -> "待機・座位"
        currentMs < seatOffMs -> "フェーズ1: 開始〜離臀前"
        currentMs < standEndMs -> "フェーズ2: 立ち上がり中"
        currentMs < stableMs -> "フェーズ3: 立位安定化中"
        else -> "フェーズ4: 立位安定"
    }

    fun seekToMs(targetMs: Long) {
        val targetIdx = frames.indexOfFirst { it.timestampMs >= targetMs }.coerceAtLeast(0)
        frameIndex = targetIdx.coerceIn(0, frames.lastIndex)
    }

    fun executeReanalysis() {
        val t0 = min(startMs, seatOffMs)
        val t1 = max(t0, min(seatOffMs, standEndMs))
        val t2 = max(t1, min(standEndMs, stableMs))
        val t3 = max(t2, stableMs)

        startMs = t0
        seatOffMs = t1
        standEndMs = t2
        stableMs = t3

        val updated = StsMetricCalculator.recalculateTrialFromTimestamps(
            repIndex = trial.repIndex,
            frames = frames,
            startTimeMs = t0,
            seatOffTimeMs = t1,
            standEndTimeMs = t2,
            stableTimeMs = t3
        )
        onTrialUpdated(updated)
        reanalyzeNotice = "イベント時刻を反映し、再解析結果を更新しました（総時間: ${String.format(Locale.US, "%.2f", updated.totalDurationSec)}秒）"
    }

    fun resetToCurrentTrial() {
        startMs = trial.startTimeMs
        seatOffMs = trial.seatOffTimeMs
        standEndMs = trial.standEndTimeMs
        stableMs = trial.stableTimeMs
        reanalyzeNotice = null
    }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "動画・骨格検証（${trial.repIndex}回目）",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                Surface(
                    color = MaterialTheme.colorScheme.primaryContainer,
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Text(
                        text = String.format(Locale.US, "%.2f s ｜ F#%d", currentMs / 1000f, frameIndex + 1),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                    )
                }
            }

            Surface(
                color = MaterialTheme.colorScheme.secondaryContainer,
                shape = RoundedCornerShape(6.dp)
            ) {
                Text(
                    text = "$phaseLabel ｜ 左 ${String.format(Locale.US, "%.1f", currentFrame.leftBiasPercent)}% / 右 ${String.format(Locale.US, "%.1f", currentFrame.rightBiasPercent)}%",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                )
            }

            // 実動画とスティックピクチャ（骨格）を横並びに表示
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(250.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                // 左側: 同一フレームの実動画
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .background(Color(0xFF0D1117), RoundedCornerShape(8.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    // 同一フレームに保持されているプレビュー画像を最優先で表示（遅延ゼロ）
                    val displayBmp = currentFrame.previewBitmap ?: videoFrameBitmap
                    if (displayBmp != null) {
                        Image(
                            bitmap = displayBmp.asImageBitmap(),
                            contentDescription = "動画フレーム",
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Fit
                        )
                    } else {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center
                        ) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(24.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.primary
                            )
                            Spacer(modifier = Modifier.height(6.dp))
                            Text(
                                text = if (videoUri != null) "動画読込中..." else "動画プレビューなし",
                                color = Color.White.copy(alpha = 0.7f),
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                    }

                    Surface(
                        color = Color.Black.copy(alpha = 0.65f),
                        shape = RoundedCornerShape(bottomEnd = 6.dp),
                        modifier = Modifier.align(Alignment.TopStart)
                    ) {
                        Text(
                            text = "実動画",
                            color = Color.White,
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                        )
                    }
                }

                // 右側: スティックピクチャ（骨格）
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .background(Color(0xFF14181F), RoundedCornerShape(8.dp))
                ) {
                    Canvas(modifier = Modifier.fillMaxSize()) {
                        val w = size.width
                        val h = size.height

                        val leftEdgeX = (currentFrame.midBaseX - currentFrame.baseWidth / 2f) * w
                        val rightEdgeX = (currentFrame.midBaseX + currentFrame.baseWidth / 2f) * w
                        val midX = currentFrame.midBaseX * w
                        val footY = (currentFrame.landmarks[27]?.y ?: currentFrame.landmarks[28]?.y ?: 0.9f) * h

                        drawLine(
                            color = Color.Cyan.copy(alpha = 0.6f),
                            start = Offset(leftEdgeX, footY),
                            end = Offset(rightEdgeX, footY),
                            strokeWidth = 4f
                        )
                        drawLine(
                            color = Color.White.copy(alpha = 0.35f),
                            start = Offset(midX, 0f),
                            end = Offset(midX, h),
                            strokeWidth = 2f,
                            pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 10f))
                        )

                        SKELETON_CONNECTIONS.forEach { (a, b) ->
                            val pA = currentFrame.landmarks[a]
                            val pB = currentFrame.landmarks[b]
                            if (pA != null && pB != null) {
                                drawLine(
                                    color = Color(0xFF90CAF9),
                                    start = Offset(pA.x * w, pA.y * h),
                                    end = Offset(pB.x * w, pB.y * h),
                                    strokeWidth = 5f
                                )
                            }
                        }

                        currentFrame.landmarks.values.forEach { pt ->
                            drawCircle(
                                color = Color.White,
                                radius = 4f,
                                center = Offset(pt.x * w, pt.y * h)
                            )
                        }

                        val hipMidY = (((currentFrame.landmarks[23]?.y ?: 0.55f) + (currentFrame.landmarks[24]?.y ?: 0.55f)) / 2f) * h
                        drawCircle(
                            color = Color(0xFFFF5252),
                            radius = 9f,
                            center = Offset(currentFrame.comX * w, hipMidY)
                        )
                    }

                    Surface(
                        color = Color.Black.copy(alpha = 0.65f),
                        shape = RoundedCornerShape(bottomEnd = 6.dp),
                        modifier = Modifier.align(Alignment.TopStart)
                    ) {
                        Text(
                            text = "スティックピクチャ",
                            color = Color.White,
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                        )
                    }
                }
            }

            // 秒数・フレーム番号を中央で大きく見やすく表示するインジケーターカード
            Surface(
                color = MaterialTheme.colorScheme.surfaceVariant,
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = String.format(Locale.US, "始: %.2fs", minMs / 1000f),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        text = String.format(Locale.US, "⏱ %.2f 秒 ｜ フレーム #%d / %d", currentMs / 1000f, frameIndex + 1, frames.size),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.primary
                    )
                    Text(
                        text = String.format(Locale.US, "終: %.2fs", maxMs / 1000f),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            Slider(
                value = frameIndex.toFloat(),
                onValueChange = {
                    frameIndex = it.toInt().coerceIn(0, frames.lastIndex)
                    reanalyzeNotice = null
                },
                valueRange = 0f..max(1, frames.lastIndex).toFloat()
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedButton(
                    onClick = {
                        frameIndex = max(0, frameIndex - 1)
                        reanalyzeNotice = null
                    },
                    modifier = Modifier.weight(1f)
                ) { Text("前フレーム (-1)") }
                OutlinedButton(
                    onClick = {
                        frameIndex = min(frames.lastIndex, frameIndex + 1)
                        reanalyzeNotice = null
                    },
                    modifier = Modifier.weight(1f)
                ) { Text("次フレーム (+1)") }
            }

            HorizontalDivider()

            Text(
                text = "イベント時刻の設定・選択",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold
            )

            EventItemRow(
                label = "開始",
                eventColor = Color(0xFF4CAF50),
                targetMs = startMs,
                onSetCurrent = {
                    startMs = currentMs
                    reanalyzeNotice = null
                },
                onJump = { seekToMs(startMs) }
            )
            EventItemRow(
                label = "離臀",
                eventColor = Color(0xFFFF9800),
                targetMs = seatOffMs,
                onSetCurrent = {
                    seatOffMs = currentMs
                    reanalyzeNotice = null
                },
                onJump = { seekToMs(seatOffMs) }
            )
            EventItemRow(
                label = "完了",
                eventColor = Color(0xFF2196F3),
                targetMs = standEndMs,
                onSetCurrent = {
                    standEndMs = currentMs
                    reanalyzeNotice = null
                },
                onJump = { seekToMs(standEndMs) }
            )
            EventItemRow(
                label = "安定",
                eventColor = Color(0xFF9C27B0),
                targetMs = stableMs,
                onSetCurrent = {
                    stableMs = currentMs
                    reanalyzeNotice = null
                },
                onJump = { seekToMs(stableMs) }
            )

            // 試行間の失敗試行（離臀失敗）記録セクション
            var recordFailuresEnabled by remember {
                mutableStateOf(analysisResult?.failedAttempts?.isNotEmpty() == true)
            }

            HorizontalDivider()

            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth()
            ) {
                Checkbox(
                    checked = recordFailuresEnabled,
                    onCheckedChange = { recordFailuresEnabled = it }
                )
                Text(
                    text = "試行間に離臀失敗（立ち上がり損ね）があれば記録",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold
                )
            }

            if (recordFailuresEnabled) {
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.35f),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(
                        modifier = Modifier.padding(10.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "離臀失敗イベントの記録（複数可能）",
                                style = MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.error
                            )
                            Button(
                                onClick = {
                                    val currentList = analysisResult?.failedAttempts ?: emptyList()
                                    if (!currentList.any { kotlin.math.abs(it.timestampMs - currentMs) < 300L }) {
                                        val updated = (currentList + FailedAttempt(timestampMs = currentMs)).sortedBy { it.timestampMs }
                                        onFailedAttemptsUpdated?.invoke(updated)
                                        reanalyzeNotice = "離臀失敗イベント（${String.format(Locale.US, "%.2f", currentMs / 1000f)}秒）を記録しました"
                                    }
                                },
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
                            ) {
                                Text("＋ 現在Fを離臀失敗として記録", style = MaterialTheme.typography.labelSmall)
                            }
                        }

                        val fails = analysisResult?.failedAttempts ?: emptyList()
                        if (fails.isEmpty()) {
                            Text(
                                text = "※スライダーを動かして離臀に失敗したフレームに合わせ、「＋ 現在Fを離臀失敗として記録」を押してください。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        } else {
                            Text(
                                text = "登録済み離臀失敗: ${fails.size}件",
                                style = MaterialTheme.typography.bodySmall,
                                fontWeight = FontWeight.Bold
                            )
                            fails.forEachIndexed { idx, fa ->
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = "失敗 #${idx + 1}: ${String.format(Locale.US, "%.2f 秒", fa.timestampMs / 1000f)}",
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = FontWeight.Medium
                                    )
                                    Row(
                                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        OutlinedButton(
                                            onClick = { seekToMs(fa.timestampMs) },
                                            contentPadding = PaddingValues(horizontal = 6.dp, vertical = 2.dp)
                                        ) {
                                            Text("確認移動", style = MaterialTheme.typography.labelSmall)
                                        }
                                        FilledTonalButton(
                                            onClick = {
                                                val updated = fails.filterNot { it == fa }
                                                onFailedAttemptsUpdated?.invoke(updated)
                                            },
                                            contentPadding = PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                                            colors = ButtonDefaults.filledTonalButtonColors(
                                                containerColor = MaterialTheme.colorScheme.errorContainer
                                            )
                                        ) {
                                            Text("削除", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if (hasPendingChanges) {
                Text(
                    text = "※イベント時刻が変更されています。「イベントを反映して再解析を実行」を押してください。",
                    color = MaterialTheme.colorScheme.tertiary,
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Bold
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Button(
                    onClick = { executeReanalysis() },
                    modifier = Modifier.weight(2f),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (hasPendingChanges) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.secondary
                    )
                ) {
                    Text(if (hasPendingChanges) "イベントを反映して再解析を実行" else "再解析を実行（更新）")
                }

                if (hasPendingChanges) {
                    OutlinedButton(
                        onClick = { resetToCurrentTrial() },
                        modifier = Modifier.weight(1f)
                    ) {
                        Text("取消")
                    }
                }
            }

            reanalyzeNotice?.let { notice ->
                Surface(
                    color = MaterialTheme.colorScheme.primaryContainer,
                    shape = RoundedCornerShape(6.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = notice,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.padding(10.dp)
                    )
                }
            }

            // 試行成績（総合: 試行数・成功数・失敗数・確率）
            if (analysisResult != null) {
                Surface(
                    color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.5f),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            text = "立ち座り試行成績（総合）",
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("総試行数: ${analysisResult.totalAttempts}回", fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodySmall)
                            Text("成功: ${analysisResult.successCount}回 (${String.format(Locale.US, "%.1f%%", analysisResult.successRatePercent)})", style = MaterialTheme.typography.bodySmall)
                            Text(
                                text = "失敗: ${analysisResult.failureCount}回 (${String.format(Locale.US, "%.1f%%", analysisResult.failureRatePercent)})",
                                style = MaterialTheme.typography.bodySmall,
                                color = if (analysisResult.failureCount > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
                            )
                        }
                    }
                }
            }

            // 直近の再解析結果
            Surface(
                color = MaterialTheme.colorScheme.surfaceVariant,
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        text = "現在反映中の解析値（${trial.repIndex}回目）",
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("総運動時間: ${String.format(Locale.US, "%.2f", trial.totalDurationSec)}秒", style = MaterialTheme.typography.bodySmall)
                        Text("離臀時間: ${String.format(Locale.US, "%.2f", trial.seatOffDurationSec)}秒", style = MaterialTheme.typography.bodySmall)
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("立ち上がり時間: ${String.format(Locale.US, "%.2f", trial.risingDurationSec)}秒", style = MaterialTheme.typography.bodySmall)
                        Text("立位安定時間: ${String.format(Locale.US, "%.2f", trial.stabilizationDurationSec)}秒", style = MaterialTheme.typography.bodySmall)
                    }
                    Text(
                        text = "左右偏倚(平均): 左 ${String.format(Locale.US, "%.1f", trial.meanLeftBiasPercent)}% / 右 ${String.format(Locale.US, "%.1f", 100f - trial.meanLeftBiasPercent)}%",
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }

            // CSVエクスポートセクション（確定後に即出力可能）
            if (analysisResult != null) {
                HorizontalDivider()

                val isMultiRep = analysisResult.trials.size > 1
                val exportTitle = if (isMultiRep) "全${analysisResult.trials.size}回＋全体レポートのCSVエクスポート" else "解析結果のCSVエクスポート"
                val dateTag = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
                val defaultFileName = if (isMultiRep) {
                    "STS_${analysisResult.mode.name}_All${analysisResult.trials.size}Reps_$dateTag.csv"
                } else {
                    "STS_Rep${trial.repIndex}_$dateTag.csv"
                }

                Text(
                    text = exportTitle,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold
                )

                if (isMultiRep) {
                    Text(
                        text = "※各回の指標（1〜${analysisResult.trials.size}回目）＋全体所要時間＋平均・標準偏差＋全フレーム時系列データを1つのCSVにまとめて出力します。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    OutlinedButton(
                        onClick = {
                            val csvContent = StsCsvExporter.generateCsv(analysisResult, trial)
                            onRequestSaveCsv?.invoke(defaultFileName, csvContent)
                        },
                        modifier = Modifier.weight(1f)
                    ) {
                        Text(if (isMultiRep) "全体＋各回CSV保存" else "CSVファイル保存")
                    }

                    FilledTonalButton(
                        onClick = {
                            val csvContent = StsCsvExporter.generateCsv(analysisResult, trial)
                            StsCsvExporter.shareCsv(context, defaultFileName, csvContent)
                        },
                        modifier = Modifier.weight(1f)
                    ) {
                        Text(if (isMultiRep) "全体＋各回CSV共有" else "CSVを共有/送信")
                    }
                }
            }
        }
    }
}

@Composable
private fun EventItemRow(
    label: String,
    eventColor: Color,
    targetMs: Long,
    onSetCurrent: () -> Unit,
    onJump: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.weight(1.2f)
        ) {
            Surface(
                color = eventColor.copy(alpha = 0.2f),
                shape = RoundedCornerShape(4.dp)
            ) {
                Text(
                    text = label,
                    color = eventColor,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                )
            }
            Text(
                text = String.format(Locale.US, "%.2f s", targetMs / 1000f),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold
            )
        }

        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.weight(1.8f)
        ) {
            FilledTonalButton(
                onClick = onSetCurrent,
                modifier = Modifier.weight(1.1f),
                contentPadding = PaddingValues(horizontal = 4.dp, vertical = 4.dp)
            ) {
                Text("現在Fをセット", style = MaterialTheme.typography.labelSmall)
            }
            OutlinedButton(
                onClick = onJump,
                modifier = Modifier.weight(0.9f),
                contentPadding = PaddingValues(horizontal = 4.dp, vertical = 4.dp)
            ) {
                Text("確認移動", style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}
