package com.example.myapplication

import android.graphics.Paint
import android.graphics.Typeface
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.util.Locale
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * 立ち座り動作（5xSTSおよび30秒立ち座り）の各回累積所要時間・立ち上がり時間グラフ
 */
@Composable
fun StsCumulativeTimeGraphCard(
    trials: List<SingleTrialMetrics>,
    mode: StsMode,
    modifier: Modifier = Modifier
) {
    if (trials.size < 2) return

    val t0 = trials.first().startTimeMs
    val cumTimes = trials.map { (it.standEndTimeMs - t0) / 1000f }
    val risingTimes = trials.map { it.risingDurationSec }
    val maxCum = cumTimes.maxOrNull() ?: 10f
    val yMax = if (mode == StsMode.THIRTY_SECONDS) max(32f, maxCum * 1.12f) else max(5f, ceil(maxCum * 1.15f))

    val onSurfaceColor = MaterialTheme.colorScheme.onSurface
    val onSurfaceVariantColor = MaterialTheme.colorScheme.onSurfaceVariant
    val primaryColor = MaterialTheme.colorScheme.primary
    val secondaryColor = MaterialTheme.colorScheme.secondary
    val outlineVariantColor = MaterialTheme.colorScheme.outlineVariant

    val avgDuration = risingTimes.average().toFloat()
    val fastestIdx = risingTimes.indices.minByOrNull { risingTimes[it] } ?: 0
    val slowestIdx = risingTimes.indices.maxByOrNull { risingTimes[it] } ?: 0

    Card(modifier = modifier.fillMaxWidth()) {
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
                    text = "各回 累積時間・立ち上がり所要時間",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = if (mode == StsMode.THIRTY_SECONDS) "30s-STS" else "5xSTS",
                    style = MaterialTheme.typography.labelSmall,
                    color = primaryColor,
                    fontWeight = FontWeight.SemiBold
                )
            }

            Text(
                text = "折れ線: 第1回開始からの累積経過時間 ｜ 縦棒: 各回の立ち上がり時間",
                style = MaterialTheme.typography.bodySmall,
                color = onSurfaceVariantColor
            )

            val scrollState = rememberScrollState()
            val isScrollable = trials.size > 7
            val dynamicWidthDp = (trials.size * 52).dp
            val canvasWidthDp = if (isScrollable) {
                if (dynamicWidthDp > 360.dp) dynamicWidthDp else 360.dp
            } else 0.dp

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .then(if (isScrollable) Modifier.horizontalScroll(scrollState) else Modifier)
            ) {
                Canvas(
                    modifier = Modifier
                        .then(if (isScrollable) Modifier.width(canvasWidthDp) else Modifier.fillMaxWidth())
                        .height(210.dp)
                ) {
                    val density = this.density
                    val padLeft = 42f * density
                    val padRight = 24f * density
                    val padTop = 26f * density
                    val padBottom = 32f * density

                    val chartWidth = size.width - padLeft - padRight
                    val chartHeight = size.height - padTop - padBottom

                    val textPaint = Paint().apply {
                        isAntiAlias = true
                        color = onSurfaceVariantColor.toArgb()
                        textSize = 9.5f * density
                        textAlign = Paint.Align.RIGHT
                    }
                    val labelPaint = Paint().apply {
                        isAntiAlias = true
                        color = onSurfaceColor.toArgb()
                        textSize = 10f * density
                        typeface = Typeface.DEFAULT_BOLD
                        textAlign = Paint.Align.CENTER
                    }
                    val badgePaint = Paint().apply {
                        isAntiAlias = true
                        color = primaryColor.toArgb()
                        textSize = 9f * density
                        typeface = Typeface.DEFAULT_BOLD
                        textAlign = Paint.Align.CENTER
                    }

                    // Y軸目盛り線（0秒, 5秒, 10秒...）
                    val stepY = if (yMax > 25f) 5f else if (yMax > 12f) 2.5f else 1f
                    var curY = 0f
                    while (curY <= yMax + 0.1f) {
                        val yPos = padTop + chartHeight * (1f - (curY / yMax))
                        drawLine(
                            color = outlineVariantColor.copy(alpha = 0.5f),
                            start = Offset(padLeft, yPos),
                            end = Offset(size.width - padRight, yPos),
                            strokeWidth = 1f * density
                        )
                        drawContext.canvas.nativeCanvas.drawText(
                            String.format(Locale.US, "%.0fs", curY),
                            padLeft - 6f * density,
                            yPos + 3.5f * density,
                            textPaint
                        )
                        curY += stepY
                    }

                    // 30秒リミット基準線（30s-STS時）
                    if (mode == StsMode.THIRTY_SECONDS && yMax >= 30f) {
                        val y30 = padTop + chartHeight * (1f - (30f / yMax))
                        drawLine(
                            color = Color(0xFFD32F2F),
                            start = Offset(padLeft, y30),
                            end = Offset(size.width - padRight, y30),
                            strokeWidth = 1.8f * density,
                            pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f * density, 6f * density))
                        )
                        val limitPaint = Paint().apply {
                            isAntiAlias = true
                            color = android.graphics.Color.parseColor("#D32F2F")
                            textSize = 9f * density
                            typeface = Typeface.DEFAULT_BOLD
                            textAlign = Paint.Align.RIGHT
                        }
                        drawContext.canvas.nativeCanvas.drawText(
                            "30s",
                            size.width - padRight - 4f * density,
                            y30 - 3f * density,
                            limitPaint
                        )
                    }

                    // X軸各試行の描画
                    val n = trials.size
                    val xPositions = FloatArray(n) { i ->
                        padLeft + (chartWidth / (n + 1)) * (i + 1)
                    }

                    // 1. 各回立ち上がり所要時間（バー）
                    val barWidth = min(22f * density, (chartWidth / (n + 1)) * 0.45f)
                    for (i in 0 until n) {
                        val cx = xPositions[i]
                        val rSec = risingTimes[i]
                        val barH = chartHeight * (rSec / yMax)
                        val barTop = padTop + chartHeight - barH

                        drawRoundRect(
                            color = secondaryColor.copy(alpha = 0.35f),
                            topLeft = Offset(cx - barWidth / 2f, barTop),
                            size = Size(barWidth, barH),
                            cornerRadius = CornerRadius(3f * density, 3f * density)
                        )

                        // バーの頭上に単回立ち上がり秒数
                        val barValPaint = Paint().apply {
                            isAntiAlias = true
                            color = secondaryColor.toArgb()
                            textSize = 8.5f * density
                            textAlign = Paint.Align.CENTER
                        }
                        drawContext.canvas.nativeCanvas.drawText(
                            String.format(Locale.US, "%.1f", rSec),
                            cx,
                            max(padTop + 10f * density, barTop - 3f * density),
                            barValPaint
                        )

                        // X軸ラベル (1回目...)
                        drawContext.canvas.nativeCanvas.drawText(
                            "${trials[i].repIndex}",
                            cx,
                            size.height - padBottom + 16f * density,
                            labelPaint
                        )
                    }

                    // 2. 累積所要時間（折れ線）
                    val linePath = Path()
                    val points = mutableListOf<Offset>()
                    for (i in 0 until n) {
                        val cx = xPositions[i]
                        val cSec = cumTimes[i]
                        val cy = padTop + chartHeight * (1f - (cSec / yMax).coerceIn(0f, 1f))
                        points.add(Offset(cx, cy))
                        if (i == 0) linePath.moveTo(cx, cy) else linePath.lineTo(cx, cy)
                    }

                    drawPath(
                        path = linePath,
                        color = primaryColor,
                        style = Stroke(width = 2.8f * density)
                    )

                    // 折れ線の各頂点マーカーとバッジ
                    for (i in 0 until n) {
                        val pt = points[i]
                        drawCircle(
                            color = primaryColor,
                            radius = 4.8f * density,
                            center = pt
                        )
                        drawCircle(
                            color = Color.White,
                            radius = 2.2f * density,
                            center = pt
                        )

                        // 累積秒数バッジ
                        drawContext.canvas.nativeCanvas.drawText(
                            String.format(Locale.US, "%.1fs", cumTimes[i]),
                            pt.x,
                            pt.y - 7f * density,
                            badgePaint
                        )
                    }
                }
            }

            // 凡例
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Box(modifier = Modifier.size(10.dp).padding(1.dp)) {
                        Canvas(Modifier.fillMaxSize()) {
                            drawCircle(primaryColor)
                        }
                    }
                    Text("累積時間 (秒)", style = MaterialTheme.typography.bodySmall)
                }

                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Box(modifier = Modifier.size(10.dp).padding(1.dp)) {
                        Canvas(Modifier.fillMaxSize()) {
                            drawRect(secondaryColor.copy(alpha = 0.6f))
                        }
                    }
                    Text("立ち上がり時間 (秒)", style = MaterialTheme.typography.bodySmall)
                }

                if (mode == StsMode.THIRTY_SECONDS) {
                    Text(
                        text = "--- 30s制限",
                        style = MaterialTheme.typography.bodySmall,
                        color = Color(0xFFD32F2F)
                    )
                }
            }

            HorizontalDivider()

            // サマリー指標
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = String.format(Locale.US, "全累積時間: %.2f 秒", cumTimes.lastOrNull() ?: 0f),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = String.format(Locale.US, "1回平均: %.2f 秒", avgDuration),
                    style = MaterialTheme.typography.bodyMedium
                )
                Text(
                    text = "最速: #${trials[fastestIdx].repIndex} (${String.format(Locale.US, "%.2fs", risingTimes[fastestIdx])})",
                    style = MaterialTheme.typography.bodySmall,
                    color = primaryColor
                )
            }
        }
    }
}

/**
 * 立ち座り動作（5xSTSおよび30秒立ち座り）の各回重心左右差（偏倚率%）グラフ
 */
@Composable
fun StsLateralBiasGraphCard(
    trials: List<SingleTrialMetrics>,
    modifier: Modifier = Modifier
) {
    if (trials.size < 2) return

    val meanBiases = trials.map { it.meanLeftBiasPercent }
    val seatOffBiases = trials.map { it.biasAtSeatOff.leftPercent }

    val onSurfaceColor = MaterialTheme.colorScheme.onSurface
    val onSurfaceVariantColor = MaterialTheme.colorScheme.onSurfaceVariant
    val outlineVariantColor = MaterialTheme.colorScheme.outlineVariant

    // 左偏倚カラー（青/シアン系）と右偏倚カラー（橙/オレンジ系）
    val leftBiasColor = Color(0xFF0288D1)
    val rightBiasColor = Color(0xFFE65100)
    val seatOffMarkerColor = Color(0xFF7B1FA2)

    val maxDev = meanBiases.map { abs(it - 50f) }.maxOrNull() ?: 5f
    val devRange = max(10f, ceil(maxDev / 5f) * 5f + 5f).coerceAtMost(45f)
    val yMin = 50f - devRange
    val yMax = 50f + devRange

    val avgLeft = meanBiases.average().toFloat()
    val variance = meanBiases.map { (it - avgLeft) * (it - avgLeft) }.average().toFloat()
    val sdLeft = sqrt(variance)

    Card(modifier = modifier.fillMaxWidth()) {
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
                    text = "各回 重心左右差（偏倚率）の推移",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    text = "正中 50%",
                    style = MaterialTheme.typography.labelSmall,
                    color = onSurfaceVariantColor
                )
            }

            Text(
                text = "正中50%より上: 左偏倚（左支持優位） ｜ 下: 右偏倚（右支持優位）",
                style = MaterialTheme.typography.bodySmall,
                color = onSurfaceVariantColor
            )

            val scrollState = rememberScrollState()
            val isScrollable = trials.size > 7
            val dynamicWidthDp = (trials.size * 52).dp
            val canvasWidthDp = if (isScrollable) {
                if (dynamicWidthDp > 360.dp) dynamicWidthDp else 360.dp
            } else 0.dp

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .then(if (isScrollable) Modifier.horizontalScroll(scrollState) else Modifier)
            ) {
                Canvas(
                    modifier = Modifier
                        .then(if (isScrollable) Modifier.width(canvasWidthDp) else Modifier.fillMaxWidth())
                        .height(210.dp)
                ) {
                    val density = this.density
                    val padLeft = 44f * density
                    val padRight = 24f * density
                    val padTop = 26f * density
                    val padBottom = 32f * density

                    val chartWidth = size.width - padLeft - padRight
                    val chartHeight = size.height - padTop - padBottom

                    val textPaint = Paint().apply {
                        isAntiAlias = true
                        color = onSurfaceVariantColor.toArgb()
                        textSize = 9.5f * density
                        textAlign = Paint.Align.RIGHT
                    }
                    val labelPaint = Paint().apply {
                        isAntiAlias = true
                        color = onSurfaceColor.toArgb()
                        textSize = 10f * density
                        typeface = Typeface.DEFAULT_BOLD
                        textAlign = Paint.Align.CENTER
                    }

                    // 目盛り線（50%正中線と補助線）
                    val stepBias = if (devRange > 20f) 10f else 5f
                    var curB = 50f - devRange
                    while (curB <= 50f + devRange + 0.1f) {
                        val yPos = padTop + chartHeight * (1f - ((curB - yMin) / (yMax - yMin)))
                        val isCenter = abs(curB - 50f) < 0.1f

                        if (isCenter) {
                            drawLine(
                                color = onSurfaceColor.copy(alpha = 0.5f),
                                start = Offset(padLeft, yPos),
                                end = Offset(size.width - padRight, yPos),
                                strokeWidth = 1.6f * density,
                                pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f * density, 6f * density))
                            )
                            drawContext.canvas.nativeCanvas.drawText(
                                "50%",
                                padLeft - 6f * density,
                                yPos + 3.5f * density,
                                Paint().apply {
                                    isAntiAlias = true
                                    color = onSurfaceColor.toArgb()
                                    textSize = 9.5f * density
                                    typeface = Typeface.DEFAULT_BOLD
                                    textAlign = Paint.Align.RIGHT
                                }
                            )
                        } else {
                            drawLine(
                                color = outlineVariantColor.copy(alpha = 0.4f),
                                start = Offset(padLeft, yPos),
                                end = Offset(size.width - padRight, yPos),
                                strokeWidth = 0.8f * density
                            )
                            val label = if (curB > 50f) "L${curB.toInt()}%" else "R${(100f - curB).toInt()}%"
                            drawContext.canvas.nativeCanvas.drawText(
                                label,
                                padLeft - 4f * density,
                                yPos + 3.5f * density,
                                textPaint
                            )
                        }
                        curB += stepBias
                    }

                    val n = trials.size
                    val xPositions = FloatArray(n) { i ->
                        padLeft + (chartWidth / (n + 1)) * (i + 1)
                    }

                    val yCenter = padTop + chartHeight * (1f - ((50f - yMin) / (yMax - yMin)))

                    // 1. 各回の偏倚バー（正中線からの乖離バー）
                    val barWidth = min(18f * density, (chartWidth / (n + 1)) * 0.38f)
                    for (i in 0 until n) {
                        val cx = xPositions[i]
                        val b = meanBiases[i]
                        val yB = padTop + chartHeight * (1f - ((b - yMin) / (yMax - yMin)).coerceIn(0f, 1f))
                        val barColor = if (b >= 50f) leftBiasColor else rightBiasColor

                        val top = min(yCenter, yB)
                        val h = max(2f * density, abs(yB - yCenter))

                        drawRoundRect(
                            color = barColor.copy(alpha = 0.35f),
                            topLeft = Offset(cx - barWidth / 2f, top),
                            size = Size(barWidth, h),
                            cornerRadius = CornerRadius(2.5f * density, 2.5f * density)
                        )

                        // X軸ラベル (試行番号)
                        drawContext.canvas.nativeCanvas.drawText(
                            "${trials[i].repIndex}",
                            cx,
                            size.height - padBottom + 16f * density,
                            labelPaint
                        )
                    }

                    // 2. 平均偏倚率の推移線
                    val meanPath = Path()
                    val meanPoints = mutableListOf<Offset>()
                    for (i in 0 until n) {
                        val cx = xPositions[i]
                        val b = meanBiases[i]
                        val cy = padTop + chartHeight * (1f - ((b - yMin) / (yMax - yMin)).coerceIn(0f, 1f))
                        meanPoints.add(Offset(cx, cy))
                        if (i == 0) meanPath.moveTo(cx, cy) else meanPath.lineTo(cx, cy)
                    }

                    drawPath(
                        path = meanPath,
                        color = leftBiasColor,
                        style = Stroke(width = 2.4f * density)
                    )

                    // 3. 離臀時の偏倚マーカー（◆）
                    for (i in 0 until n) {
                        val cx = xPositions[i]
                        val soB = seatOffBiases[i]
                        val soY = padTop + chartHeight * (1f - ((soB - yMin) / (yMax - yMin)).coerceIn(0f, 1f))

                        val d = 4.5f * density
                        val diamondPath = Path().apply {
                            moveTo(cx, soY - d)
                            lineTo(cx + d, soY)
                            lineTo(cx, soY + d)
                            lineTo(cx - d, soY)
                            close()
                        }
                        drawPath(diamondPath, seatOffMarkerColor)
                    }

                    // 4. 各頂点のサークルと偏倚パーセント表示
                    for (i in 0 until n) {
                        val pt = meanPoints[i]
                        val b = meanBiases[i]
                        val ptColor = if (b >= 50f) leftBiasColor else rightBiasColor

                        drawCircle(ptColor, radius = 4.5f * density, center = pt)
                        drawCircle(Color.White, radius = 2f * density, center = pt)

                        val badgeText = if (b >= 50f) {
                            String.format(Locale.US, "L%.1f%%", b)
                        } else {
                            String.format(Locale.US, "R%.1f%%", 100f - b)
                        }
                        val valPaint = Paint().apply {
                            isAntiAlias = true
                            color = ptColor.toArgb()
                            textSize = 8.5f * density
                            typeface = Typeface.DEFAULT_BOLD
                            textAlign = Paint.Align.CENTER
                        }
                        val yOffset = if (b >= 50f) -7f * density else 14f * density
                        drawContext.canvas.nativeCanvas.drawText(badgeText, pt.x, pt.y + yOffset, valPaint)
                    }
                }
            }

            // 凡例
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Box(modifier = Modifier.size(10.dp).padding(1.dp)) {
                        Canvas(Modifier.fillMaxSize()) { drawRect(leftBiasColor) }
                    }
                    Text("左偏倚 (>50%)", style = MaterialTheme.typography.bodySmall)
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Box(modifier = Modifier.size(10.dp).padding(1.dp)) {
                        Canvas(Modifier.fillMaxSize()) { drawRect(rightBiasColor) }
                    }
                    Text("右偏倚 (>50%)", style = MaterialTheme.typography.bodySmall)
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Box(modifier = Modifier.size(10.dp).padding(1.dp)) {
                        Canvas(Modifier.fillMaxSize()) {
                            drawCircle(seatOffMarkerColor)
                        }
                    }
                    Text("◆ 離臀時偏倚", style = MaterialTheme.typography.bodySmall)
                }
            }

            HorizontalDivider()

            // サマリー指標
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = String.format(
                        Locale.US,
                        "全平均: 左%.1f%% / 右%.1f%%",
                        avgLeft,
                        100f - avgLeft
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = String.format(Locale.US, "ばらつき (SD): ±%.1f%%", sdLeft),
                    style = MaterialTheme.typography.bodySmall,
                    color = onSurfaceVariantColor
                )
            }
        }
    }
}
