package com.example.stsanalyzer

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round

object StsMetricCalculator {

    private val trackedIndices = listOf(11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32)

    fun calculate(
        rawFrames: List<PoseFrameData>,
        mode: StsMode,
        isFrontCameraMirrored: Boolean = false
    ): StsAnalysisResult {
        require(rawFrames.size >= 5) { "解析に十分なフレーム数がありません（最低5フレーム必要）。" }

        val frames = interpolateAndRecomputeBias(rawFrames, isFrontCameraMirrored)

        val rawHipY = frames.map { frame ->
            val lHip = frame.landmarks[23]?.y ?: 0.55f
            val rHip = frame.landmarks[24]?.y ?: 0.55f
            (lHip + rHip) / 2f
        }
        val rawShoulderY = frames.map { frame ->
            val lSh = frame.landmarks[11]?.y ?: 0.30f
            val rSh = frame.landmarks[12]?.y ?: 0.30f
            (lSh + rSh) / 2f
        }

        val hipY = movingAverage(rawHipY, windowSize = 5)
        val shoulderY = movingAverage(rawShoulderY, windowSize = 5)

        val standHipY = hipY.minOrNull()!!
        val sitHipY = hipY.maxOrNull()!!

        val standingPeakIndices = findRisingPeaks(
            hipY = hipY,
            sitY = sitHipY,
            standY = standHipY,
            expectedCount = mode.targetReps
        )

        val trials = standingPeakIndices.mapIndexed { repIdx, peakIdx ->
            val searchStartIdx = if (repIdx == 0) {
                0
            } else {
                val prevPeak = standingPeakIndices[repIdx - 1]
                if (peakIdx > prevPeak + 2) {
                    val subSlice = hipY.subList(prevPeak, peakIdx)
                    val localMaxOffset = subSlice.indices.maxByOrNull { subSlice[it] } ?: 0
                    prevPeak + localMaxOffset
                } else {
                    prevPeak
                }
            }

            buildSingleTrialMetrics(
                repIndex = repIdx + 1,
                frames = frames,
                hipY = hipY,
                shoulderY = shoulderY,
                searchStartIdx = searchStartIdx,
                peakIdx = peakIdx
            )
        }

        val overallTotalSec = if (mode == StsMode.FIVE_TIMES && trials.size >= 5) {
            max(0f, (trials[4].stableTimeMs - trials.first().startTimeMs) / 1000f)
        } else {
            null
        }

        return StsAnalysisResult(
            mode = mode,
            trials = trials,
            overallTotalDurationSec = overallTotalSec,
            frames = frames,
            isFrontCameraMirrored = isFrontCameraMirrored
        )
    }

    fun recalculateTrialFromTimestamps(
        repIndex: Int,
        frames: List<PoseFrameData>,
        startTimeMs: Long,
        seatOffTimeMs: Long,
        standEndTimeMs: Long,
        stableTimeMs: Long
    ): SingleTrialMetrics {
        val t0 = min(startTimeMs, seatOffTimeMs)
        val t1 = max(t0, min(seatOffTimeMs, standEndTimeMs))
        val t2 = max(t1, min(standEndTimeMs, stableTimeMs))
        val t3 = max(t2, stableTimeMs)

        val fStart = nearestFrame(frames, t0)
        val fSeat = nearestFrame(frames, t1)
        val fStand = nearestFrame(frames, t2)
        val fStable = nearestFrame(frames, t3)

        val startIdx = frames.indexOf(fStart).coerceAtLeast(0)
        val stableIdx = frames.indexOf(fStable).coerceAtLeast(startIdx)
        val slice = frames.subList(startIdx, min(frames.size, stableIdx + 1))
        val meanLeft = if (slice.isNotEmpty()) {
            slice.map { it.leftBiasPercent }.average().toFloat()
        } else {
            50f
        }

        return SingleTrialMetrics(
            repIndex = repIndex,
            startTimeMs = fStart.timestampMs,
            seatOffTimeMs = fSeat.timestampMs,
            standEndTimeMs = fStand.timestampMs,
            stableTimeMs = fStable.timestampMs,
            totalDurationSec = max(0f, (fStable.timestampMs - fStart.timestampMs) / 1000f),
            seatOffDurationSec = max(0f, (fSeat.timestampMs - fStart.timestampMs) / 1000f),
            risingDurationSec = max(0f, (fStand.timestampMs - fSeat.timestampMs) / 1000f),
            stabilizationDurationSec = max(0f, (fStable.timestampMs - fStand.timestampMs) / 1000f),
            biasAtStart = fStart.toTimingBias(),
            biasAtSeatOff = fSeat.toTimingBias(),
            biasAtStandEnd = fStand.toTimingBias(),
            biasAtStable = fStable.toTimingBias(),
            meanLeftBiasPercent = meanLeft
        )
    }

    private fun interpolateAndRecomputeBias(
        rawFrames: List<PoseFrameData>,
        isFrontCameraMirrored: Boolean
    ): List<PoseFrameData> {
        val mutableLandmarks = rawFrames.map { it.landmarks.toMutableMap() }

        for (idx in trackedIndices) {
            for (f in 1 until rawFrames.size) {
                val prev = mutableLandmarks[f - 1][idx]
                val curr = mutableLandmarks[f][idx]
                if (prev != null && curr != null) {
                    val dist = hypot((curr.x - prev.x).toDouble(), (curr.y - prev.y).toDouble())
                    if (dist > 0.16) {
                        mutableLandmarks[f].remove(idx)
                    }
                }
            }

            for (f in rawFrames.indices) {
                if (mutableLandmarks[f][idx] == null) {
                    var prevValid = f - 1
                    while (prevValid >= 0 && mutableLandmarks[prevValid][idx] == null) prevValid--
                    var nextValid = f + 1
                    while (nextValid < rawFrames.size && mutableLandmarks[nextValid][idx] == null) nextValid++

                    val pPrev = if (prevValid >= 0) mutableLandmarks[prevValid][idx] else null
                    val pNext = if (nextValid < rawFrames.size) mutableLandmarks[nextValid][idx] else null

                    val filled = when {
                        pPrev != null && pNext != null -> {
                            val ratio = (f - prevValid).toFloat() / max(1, nextValid - prevValid)
                            Point2D(
                                x = pPrev.x + (pNext.x - pPrev.x) * ratio,
                                y = pPrev.y + (pNext.y - pPrev.y) * ratio
                            )
                        }
                        pPrev != null -> pPrev
                        pNext != null -> pNext
                        else -> null
                    }
                    if (filled != null) {
                        mutableLandmarks[f][idx] = filled
                    }
                }
            }
        }

        return rawFrames.mapIndexed { i, frame ->
            val lm = mutableLandmarks[i]
            val lShoulder = lm[11]
            val rShoulder = lm[12]
            val lHip = lm[23]
            val rHip = lm[24]
            if (lShoulder == null || rShoulder == null || lHip == null || rHip == null) {
                frame
            } else {
                val lFootX = averageX(lm[27], lm[29], lm[31]) ?: lHip.x
                val rFootX = averageX(lm[28], lm[30], lm[32]) ?: rHip.x
                val midBaseX = (lFootX + rFootX) / 2f
                val pelvisWidth = abs(lHip.x - rHip.x)
                val baseWidth = max(abs(lFootX - rFootX), max(0.06f, pelvisWidth * 0.8f))

                val midShoulderX = (lShoulder.x + rShoulder.x) / 2f
                val midHipX = (lHip.x + rHip.x) / 2f
                val midFootX = (lFootX + rFootX) / 2f
                val comX = 0.30f * midShoulderX + 0.40f * midHipX + 0.30f * midFootX

                val signedShift = if (isFrontCameraMirrored) midBaseX - comX else comX - midBaseX
                val leftBias = (50f + (signedShift / baseWidth) * 100f).coerceIn(0f, 100f)

                frame.copy(
                    landmarks = lm,
                    comX = comX,
                    midBaseX = midBaseX,
                    baseWidth = baseWidth,
                    leftBiasPercent = leftBias,
                    rightBiasPercent = 100f - leftBias
                )
            }
        }
    }

    private fun buildSingleTrialMetrics(
        repIndex: Int,
        frames: List<PoseFrameData>,
        hipY: List<Float>,
        shoulderY: List<Float>,
        searchStartIdx: Int,
        peakIdx: Int
    ): SingleTrialMetrics {
        val peakHipY = hipY[peakIdx]
        val baselineSitHipY = hipY.subList(searchStartIdx, peakIdx + 1).maxOrNull() ?: hipY[peakIdx]
        val excursion = max(0.02f, baselineSitHipY - peakHipY)

        val baselineShoulderY = shoulderY.subList(searchStartIdx, peakIdx + 1).maxOrNull() ?: shoulderY[peakIdx]
        val shoulderExcursion = max(0.02f, baselineShoulderY - shoulderY[peakIdx])

        var startIdx = searchStartIdx
        for (i in searchStartIdx until peakIdx) {
            val hipMoved = (baselineSitHipY - hipY[i]) >= excursion * 0.08f
            val trunkLeaned = (baselineShoulderY - shoulderY[i]) >= shoulderExcursion * 0.10f
            if (hipMoved || trunkLeaned) {
                startIdx = i
                break
            }
        }

        var seatOffIdx = startIdx
        for (i in startIdx..peakIdx) {
            if ((baselineSitHipY - hipY[i]) >= excursion * 0.22f) {
                seatOffIdx = i
                break
            }
        }

        var standEndIdx = peakIdx
        val targetStandY = baselineSitHipY - excursion * 0.90f
        for (i in seatOffIdx..peakIdx) {
            if (hipY[i] <= targetStandY) {
                standEndIdx = i
                break
            }
        }

        val lastIdx = frames.lastIndex
        val windowFrames = max(2, estimateWindowFrames(frames, targetMs = 300L))
        var stableIdx = min(lastIdx, standEndIdx + windowFrames)

        for (i in standEndIdx..(lastIdx - windowFrames)) {
            val slice = frames.subList(i, i + windowFrames).map { it.leftBiasPercent }
            val spread = (slice.maxOrNull() ?: 50f) - (slice.minOrNull() ?: 50f)
            if (spread <= 2.5f) {
                stableIdx = i
                break
            }
        }
        stableIdx = max(standEndIdx, min(lastIdx, stableIdx))

        return recalculateTrialFromTimestamps(
            repIndex = repIndex,
            frames = frames,
            startTimeMs = frames[startIdx].timestampMs,
            seatOffTimeMs = frames[seatOffIdx].timestampMs,
            standEndTimeMs = frames[standEndIdx].timestampMs,
            stableTimeMs = frames[stableIdx].timestampMs
        )
    }

    private fun nearestFrame(frames: List<PoseFrameData>, targetMs: Long): PoseFrameData {
        return frames.minByOrNull { abs(it.timestampMs - targetMs) } ?: frames.first()
    }

    private fun PoseFrameData.toTimingBias() = TimingBias(
        timestampMs = timestampMs,
        leftPercent = leftBiasPercent,
        rightPercent = rightBiasPercent
    )

    private fun findRisingPeaks(
        hipY: List<Float>,
        sitY: Float,
        standY: Float,
        expectedCount: Int
    ): List<Int> {
        val range = max(0.03f, sitY - standY)
        val candidateThresholdY = sitY - range * 0.65f
        val minSeparationIndices = max(5, hipY.size / max(expectedCount * 3, 6))

        val candidates = mutableListOf<Int>()
        for (i in 1 until hipY.lastIndex) {
            if (hipY[i] <= candidateThresholdY && hipY[i] <= hipY[i - 1] && hipY[i] <= hipY[i + 1]) {
                if (candidates.isEmpty() || i - candidates.last() >= minSeparationIndices) {
                    candidates.add(i)
                } else {
                    val prevIdx = candidates.last()
                    if (hipY[i] < hipY[prevIdx]) {
                        candidates[candidates.lastIndex] = i
                    }
                }
            }
        }

        if (candidates.isEmpty()) {
            return listOf(hipY.indices.minByOrNull { hipY[it] } ?: 0)
        }
        return if (candidates.size > expectedCount) {
            candidates.sortedBy { hipY[it] }.take(expectedCount).sorted()
        } else {
            candidates
        }
    }

    private fun movingAverage(values: List<Float>, windowSize: Int): List<Float> {
        if (values.isEmpty() || windowSize <= 1) return values
        val half = windowSize / 2
        return values.indices.map { idx ->
            val from = max(0, idx - half)
            val to = min(values.lastIndex, idx + half)
            values.subList(from, to + 1).average().toFloat()
        }
    }

    private fun estimateWindowFrames(frames: List<PoseFrameData>, targetMs: Long): Int {
        if (frames.size < 2) return 5
        val totalMs = max(1L, frames.last().timestampMs - frames.first().timestampMs)
        val avgDt = totalMs.toFloat() / (frames.size - 1)
        return max(2, round(targetMs / max(1f, avgDt)).toInt())
    }

    private fun averageX(vararg pts: Point2D?): Float? {
        val valid = pts.filterNotNull()
        return if (valid.isEmpty()) null else valid.map { it.x }.average().toFloat()
    }
}
