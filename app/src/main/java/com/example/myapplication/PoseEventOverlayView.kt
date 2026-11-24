package com.example.myapplication

import androidx.compose.foundation.Canvas
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
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

@Composable
fun PoseEventOverlayCard(
    frames: List<PoseFrameData>,
    trial: SingleTrialMetrics,
    onTrialUpdated: (SingleTrialMetrics) -> Unit
) {
    if (frames.isEmpty()) return

    var frameIndex by remember(trial.repIndex) {
        mutableIntStateOf(
            frames.indexOfFirst { it.timestampMs >= trial.startTimeMs }.coerceAtLeast(0)
        )
    }

    val currentFrame = frames[frameIndex.coerceIn(0, frames.lastIndex)]
    val minMs = frames.first().timestampMs
    val maxMs = frames.last().timestampMs

    val phaseLabel = when {
        currentFrame.timestampMs < trial.startTimeMs -> "待機・座位"
        currentFrame.timestampMs < trial.seatOffTimeMs -> "フェーズ1: 開始〜離臀前"
        currentFrame.timestampMs < trial.standEndTimeMs -> "フェーズ2: 立ち上がり中"
        currentFrame.timestampMs < trial.stableTimeMs -> "フェーズ3: 立位安定化中"
        else -> "フェーズ4: 立位安定"
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
                    text = "骨格・イベント検証ビュー",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = String.format(Locale.US, "%.2f s", currentFrame.timestampMs / 1000f),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold
                )
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

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(260.dp)
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
                            radius = 5f,
                            center = Offset(pt.x * w, pt.y * h)
                        )
                    }

                    val hipMidY = (((currentFrame.landmarks[23]?.y ?: 0.55f) + (currentFrame.landmarks[24]?.y ?: 0.55f)) / 2f) * h
                    drawCircle(
                        color = Color(0xFFFF5252),
                        radius = 11f,
                        center = Offset(currentFrame.comX * w, hipMidY)
                    )
                }
            }

            Slider(
                value = frameIndex.toFloat(),
                onValueChange = { frameIndex = it.toInt().coerceIn(0, frames.lastIndex) },
                valueRange = 0f..max(1, frames.lastIndex).toFloat()
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedButton(
                    onClick = { frameIndex = max(0, frameIndex - 1) },
                    modifier = Modifier.weight(1f)
                ) { Text("前フレーム") }
                OutlinedButton(
                    onClick = { frameIndex = min(frames.lastIndex, frameIndex + 1) },
                    modifier = Modifier.weight(1f)
                ) { Text("次フレーム") }
            }

            Text(
                text = "現在フレームをイベント時刻に反映（微調整）",
                style = MaterialTheme.typography.labelLarge
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                EventSetChip("開始", minMs, maxMs, currentFrame.timestampMs) { t ->
                    onTrialUpdated(
                        StsMetricCalculator.recalculateTrialFromTimestamps(
                            trial.repIndex, frames, t, trial.seatOffTimeMs, trial.standEndTimeMs, trial.stableTimeMs
                        )
                    )
                }
                EventSetChip("離臀", minMs, maxMs, currentFrame.timestampMs) { t ->
                    onTrialUpdated(
                        StsMetricCalculator.recalculateTrialFromTimestamps(
                            trial.repIndex, frames, trial.startTimeMs, t, trial.standEndTimeMs, trial.stableTimeMs
                        )
                    )
                }
                EventSetChip("完了", minMs, maxMs, currentFrame.timestampMs) { t ->
                    onTrialUpdated(
                        StsMetricCalculator.recalculateTrialFromTimestamps(
                            trial.repIndex, frames, trial.startTimeMs, trial.seatOffTimeMs, t, trial.stableTimeMs
                        )
                    )
                }
                EventSetChip("安定", minMs, maxMs, currentFrame.timestampMs) { t ->
                    onTrialUpdated(
                        StsMetricCalculator.recalculateTrialFromTimestamps(
                            trial.repIndex, frames, trial.startTimeMs, trial.seatOffTimeMs, trial.standEndTimeMs, t
                        )
                    )
                }
            }
        }
    }
}

@Composable
private fun RowScope.EventSetChip(
    label: String,
    minMs: Long,
    maxMs: Long,
    currentMs: Long,
    onSelect: (Long) -> Unit
) {
    FilledTonalButton(
        onClick = { onSelect(currentMs.coerceIn(minMs, maxMs)) },
        modifier = Modifier.weight(1f),
        contentPadding = PaddingValues(horizontal = 4.dp, vertical = 6.dp)
    ) {
        Text(label, style = MaterialTheme.typography.labelMedium)
    }
}
