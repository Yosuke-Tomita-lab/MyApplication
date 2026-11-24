package com.example.myapplication

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round

object StsMetricCalculator {

    private const val GRAVITY = 9.80665f
    private val trackedIndices = listOf(11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32)

    fun calculate(
        rawFrames: List<PoseFrameData>,
        mode: StsMode,
        anthropometrics: SubjectAnthropometrics = SubjectAnthropometrics(),
        isFrontCameraMirrored: Boolean = false,
        customThirtySecReps: Int? = null
    ): StsAnalysisResult {
        require(rawFrames.size >= 5) { "解析に十分なフレーム数がありません（最低5フレーム必要）。" }

        val baseFrames = interpolateAndRecomputeCom(rawFrames, isFrontCameraMirrored)
        val framesWithGrf = attachEstimatedGrf(
            frames = baseFrames,
            anthropometrics = anthropometrics,
            isFrontCameraMirrored = isFrontCameraMirrored
        )

        val rawHipY = framesWithGrf.map { frame ->
            val lHip = frame.landmarks[23]?.y ?: 0.55f
            val rHip = frame.landmarks[24]?.y ?: 0.55f
            (lHip + rHip) / 2f
        }
        val rawShoulderY = framesWithGrf.map { frame ->
            val lSh = frame.landmarks[11]?.y ?: 0.30f
            val rSh = frame.landmarks[12]?.y ?: 0.30f
            (lSh + rSh) / 2f
        }

        val hipY = movingAverage(rawHipY, windowSize = 5)
        val shoulderY = movingAverage(rawShoulderY, windowSize = 5)

        val standHipY = hipY.minOrNull()!!
        val sitHipY = hipY.maxOrNull()!!

        val is30s = mode == StsMode.THIRTY_SECONDS
        val expectedCount = if (is30s) {
            customThirtySecReps?.coerceIn(1, 60) ?: 10
        } else {
            mode.targetReps
        }

        val allCandidates = findRisingPeaks(
            frames = framesWithGrf,
            hipY = hipY,
            sitY = sitHipY,
            standY = standHipY,
            expectedCount = 0
        )

        val standingPeakIndices: List<Int> = if (is30s) {
            if (customThirtySecReps != null && customThirtySecReps > 0) {
                val targetN = customThirtySecReps.coerceIn(1, 60)
                if (allCandidates.size >= targetN) {
                    allCandidates.take(targetN)
                } else {
                    val supplemented = allCandidates.toMutableList()
                    val lastIdx = framesWithGrf.lastIndex
                    val baseStep = if (supplemented.size >= 2) {
                        max(12, (supplemented.last() - supplemented.first()) / (supplemented.size - 1))
                    } else {
                        max(15, framesWithGrf.size / (targetN + 1))
                    }
                    while (supplemented.size < targetN) {
                        val nextIdx = min(lastIdx - 4, (supplemented.lastOrNull() ?: 10) + baseStep)
                        supplemented.add(nextIdx)
                    }
                    supplemented.sorted()
                }
            } else {
                if (allCandidates.isNotEmpty()) allCandidates else listOf(framesWithGrf.size / 2)
            }
        } else {
            if (expectedCount > 0 && allCandidates.size > expectedCount) {
                allCandidates.sortedBy { hipY[it] }.take(expectedCount).sorted()
            } else {
                allCandidates
            }
        }

        val rawTrials = standingPeakIndices.mapIndexed { repIdx, peakIdx ->
            val prevPeak = if (repIdx == 0) 0 else standingPeakIndices[repIdx - 1]

            buildSingleTrialMetrics(
                repIndex = repIdx + 1,
                frames = framesWithGrf,
                hipY = hipY,
                shoulderY = shoulderY,
                prevPeakIdx = prevPeak,
                peakIdx = peakIdx,
                is30s = is30s
            )
        }

        // 30秒立ち座りの場合、第1回開始時刻から30.0秒以内に終了した試行のみ含める
        // （6回目など、1回目開始から30秒を経過している試行は含めない）
        val trials = if (is30s && rawTrials.isNotEmpty()) {
            val t0 = rawTrials.first().startTimeMs
            rawTrials.filter { it.standEndTimeMs <= t0 + 30_000L }
        } else {
            rawTrials
        }

        val autoFailedAttempts = detectFailedAttempts(
            hipY = hipY,
            frames = framesWithGrf,
            standingPeakIndices = standingPeakIndices,
            sitHipY = sitHipY,
            standHipY = standHipY
        )

        val overallTotalSec = when {
            mode == StsMode.FIVE_TIMES && trials.size >= 5 -> {
                max(0f, (trials[4].stableTimeMs - trials.first().startTimeMs) / 1000f)
            }
            mode == StsMode.THIRTY_SECONDS && trials.isNotEmpty() -> {
                val t0 = trials.first().startTimeMs
                val lastTime = trials.last().standEndTimeMs
                min(30.0f, max(0f, (lastTime - t0) / 1000f))
            }
            else -> null
        }

        return StsAnalysisResult(
            mode = mode,
            anthropometrics = anthropometrics,
            trials = trials,
            overallTotalDurationSec = overallTotalSec,
            frames = framesWithGrf,
            isFrontCameraMirrored = isFrontCameraMirrored,
            failedAttempts = autoFailedAttempts
        )
    }

    /**
     * 30秒立ち座りにおいて、動画を確認後にユーザーが入力した立ち上がり総数（newCount）に合わせて
     * 既存の試行を維持しつつ、試行枠を増減・補完する
     */
    fun adjustTrialsCount(
        currentResult: StsAnalysisResult,
        newCount: Int
    ): StsAnalysisResult {
        val targetN = newCount.coerceIn(1, 60)
        val frames = currentResult.frames
        val existingTrials = currentResult.trials
        if (existingTrials.size == targetN || frames.isEmpty()) return currentResult

        if (existingTrials.size > targetN) {
            val trimmed = existingTrials.take(targetN)
            val t0 = trimmed.first().startTimeMs
            val lastEnd = trimmed.last().standEndTimeMs
            val overallSec = min(30.0f, max(0f, (lastEnd - t0) / 1000f))
            return currentResult.copy(
                trials = trimmed,
                overallTotalDurationSec = overallSec
            )
        }

        val addedTrials = mutableListOf<SingleTrialMetrics>()
        val rawHipY = frames.map { frame ->
            val lHip = frame.landmarks[23]?.y ?: 0.55f
            val rHip = frame.landmarks[24]?.y ?: 0.55f
            (lHip + rHip) / 2f
        }
        val hipY = movingAverage(rawHipY, windowSize = 5)
        val rawShoulderY = frames.map { frame ->
            val lSh = frame.landmarks[11]?.y ?: 0.30f
            val rSh = frame.landmarks[12]?.y ?: 0.30f
            (lSh + rSh) / 2f
        }
        val shoulderY = movingAverage(rawShoulderY, windowSize = 5)

        val standHipY = hipY.minOrNull() ?: 0.3f
        val sitHipY = hipY.maxOrNull() ?: 0.7f

        val allPeaks = findRisingPeaks(
            frames = frames,
            hipY = hipY,
            sitY = sitHipY,
            standY = standHipY,
            expectedCount = 0
        )

        val existingEndMs = existingTrials.lastOrNull()?.standEndTimeMs ?: 0L
        val remainingPeaks = allPeaks.filter { frames[it].timestampMs > existingEndMs + 300L }

        var curRep = existingTrials.size + 1
        var peakIdxInRemaining = 0

        while (curRep <= targetN) {
            if (peakIdxInRemaining < remainingPeaks.size) {
                val peakIdx = remainingPeaks[peakIdxInRemaining]
                val prevPeak = if ((existingTrials + addedTrials).isEmpty()) 0 else {
                    val prevTrial = (existingTrials + addedTrials).last()
                    frames.indexOfFirst { it.timestampMs >= prevTrial.standEndTimeMs }.coerceAtLeast(0)
                }
                val trial = buildSingleTrialMetrics(
                    repIndex = curRep,
                    frames = frames,
                    hipY = hipY,
                    shoulderY = shoulderY,
                    prevPeakIdx = prevPeak,
                    peakIdx = peakIdx,
                    is30s = true
                )
                addedTrials.add(trial)
                peakIdxInRemaining++
            } else {
                val prevTrial = (existingTrials + addedTrials).lastOrNull()
                val dt = if (prevTrial != null) max(1000L, prevTrial.standEndTimeMs - prevTrial.startTimeMs) else 2000L
                val baseTime = prevTrial?.standEndTimeMs ?: frames.first().timestampMs
                val newStart = min(frames.last().timestampMs - 400L, baseTime + 200L)
                val newSeat = min(frames.last().timestampMs - 200L, newStart + dt / 3)
                val newEnd = min(frames.last().timestampMs, newStart + dt)
                val trial = recalculateTrialFromTimestamps(
                    repIndex = curRep,
                    frames = frames,
                    startTimeMs = newStart,
                    seatOffTimeMs = newSeat,
                    standEndTimeMs = newEnd,
                    stableTimeMs = newEnd
                )
                addedTrials.add(trial)
            }
            curRep++
        }

        val allTrials = existingTrials + addedTrials
        // 30秒立ち座りの場合、第1回開始時刻から30.0秒以内に終了した試行のみ含める
        val validTrials = if (allTrials.isNotEmpty()) {
            val t0 = allTrials.first().startTimeMs
            allTrials.filter { it.standEndTimeMs <= t0 + 30_000L }
        } else {
            allTrials
        }
        val t0 = validTrials.firstOrNull()?.startTimeMs ?: 0L
        val lastEnd = validTrials.lastOrNull()?.standEndTimeMs ?: 0L
        val overallSec = if (validTrials.isNotEmpty()) min(30.0f, max(0f, (lastEnd - t0) / 1000f)) else 0f

        return currentResult.copy(
            trials = validTrials,
            overallTotalDurationSec = overallSec
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
        val seatIdx = frames.indexOf(fSeat).coerceAtLeast(startIdx)
        val stableIdx = frames.indexOf(fStable).coerceAtLeast(seatIdx)

        val meanSlice = frames.subList(startIdx, min(frames.size, stableIdx + 1))
        val meanLeft = if (meanSlice.isNotEmpty()) {
            meanSlice.map { it.leftBiasPercent }.average().toFloat()
        } else {
            50f
        }

        val grfSlice = frames.subList(seatIdx, min(frames.size, stableIdx + 1))
            .mapNotNull { it.grf }

        val peakVertBw = grfSlice.maxOfOrNull { it.verticalPercentBw } ?: 100f
        val peakVertN = grfSlice.maxOfOrNull { it.verticalNewton } ?: 0f
        val minVertBw = grfSlice.minOfOrNull { it.verticalPercentBw } ?: 100f
        val minVertN = grfSlice.minOfOrNull { it.verticalNewton } ?: 0f

        val peakLatLeftBw = grfSlice.maxOfOrNull { it.lateralPercentBw } ?: 0f
        val peakLatLeftN = grfSlice.maxOfOrNull { it.lateralNewton } ?: 0f
        val minLatValBw = grfSlice.minOfOrNull { it.lateralPercentBw } ?: 0f
        val minLatValN = grfSlice.minOfOrNull { it.lateralNewton } ?: 0f

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
            meanLeftBiasPercent = meanLeft,
            peakVerticalBwPercent = peakVertBw,
            peakVerticalNewton = peakVertN,
            minVerticalBwPercent = minVertBw,
            minVerticalNewton = minVertN,
            peakLateralLeftBwPercent = max(0f, peakLatLeftBw),
            peakLateralLeftNewton = max(0f, peakLatLeftN),
            peakLateralRightBwPercent = abs(min(0f, minLatValBw)),
            peakLateralRightNewton = abs(min(0f, minLatValN))
        )
    }

    private fun attachEstimatedGrf(
        frames: List<PoseFrameData>,
        anthropometrics: SubjectAnthropometrics,
        isFrontCameraMirrored: Boolean
    ): List<PoseFrameData> {
        val massKg = anthropometrics.weightKg.coerceIn(20f, 250f)
        val heightMeters = anthropometrics.heightCm.coerceIn(100f, 240f) / 100f

        val minTopY = frames.mapNotNull { f ->
            listOfNotNull(f.landmarks[0]?.y, f.landmarks[11]?.y, f.landmarks[12]?.y).minOrNull()
        }.minOrNull() ?: 0.15f

        val maxFootY = frames.mapNotNull { f ->
            listOfNotNull(f.landmarks[27]?.y, f.landmarks[28]?.y, f.landmarks[29]?.y, f.landmarks[30]?.y).maxOrNull()
        }.maxOrNull() ?: 0.90f

        val estimatedStandingNormHeight = max(0.30f, (maxFootY - minTopY) * 1.12f)
        val metersPerNormUnit = heightMeters / estimatedStandingNormHeight

        val smoothComX = movingAverage(frames.map { it.comX }, windowSize = 7)
        val smoothComY = movingAverage(frames.map { it.comY }, windowSize = 7)

        val vx = MutableList(frames.size) { 0f }
        val vyUpward = MutableList(frames.size) { 0f }

        for (i in 1 until frames.size) {
            val dtSec = max(0.008f, (frames[i].timestampMs - frames[i - 1].timestampMs) / 1000f)
            val dxMeters = (smoothComX[i] - smoothComX[i - 1]) * metersPerNormUnit
            val dyUpMeters = -(smoothComY[i] - smoothComY[i - 1]) * metersPerNormUnit
            vx[i] = dxMeters / dtSec
            vyUpward[i] = dyUpMeters / dtSec
        }

        val smoothVx = movingAverage(vx, windowSize = 5)
        val smoothVy = movingAverage(vyUpward, windowSize = 5)

        val ax = MutableList(frames.size) { 0f }
        val ayUpward = MutableList(frames.size) { 0f }

        for (i in 1 until frames.size) {
            val dtSec = max(0.008f, (frames[i].timestampMs - frames[i - 1].timestampMs) / 1000f)
            ax[i] = ((smoothVx[i] - smoothVx[i - 1]) / dtSec).coerceIn(-15f, 15f)
            ayUpward[i] = ((smoothVy[i] - smoothVy[i - 1]) / dtSec).coerceIn(-15f, 15f)
        }

        val smoothAx = movingAverage(ax, windowSize = 5)
        val smoothAy = movingAverage(ayUpward, windowSize = 5)

        return frames.mapIndexed { i, frame ->
            val signedAxLeft = if (isFrontCameraMirrored) -smoothAx[i] else smoothAx[i]
            val ay = smoothAy[i]

            val verticalN = max(0f, massKg * (GRAVITY + ay))
            val verticalBw = max(0f, (1f + ay / GRAVITY) * 100f)

            val lateralN = massKg * signedAxLeft
            val lateralBw = (signedAxLeft / GRAVITY) * 100f

            frame.copy(
                grf = GrfSample(
                    verticalPercentBw = verticalBw,
                    verticalNewton = verticalN,
                    lateralPercentBw = lateralBw,
                    lateralNewton = lateralN
                )
            )
        }
    }

    private fun interpolateAndRecomputeCom(
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

                val midShoulderY = (lShoulder.y + rShoulder.y) / 2f
                val midHipY = (lHip.y + rHip.y) / 2f
                val lFootY = averageY(lm[27], lm[29], lm[31]) ?: lHip.y
                val rFootY = averageY(lm[28], lm[30], lm[32]) ?: rHip.y
                val midFootY = (lFootY + rFootY) / 2f
                val comY = 0.30f * midShoulderY + 0.40f * midHipY + 0.30f * midFootY

                val signedShift = if (isFrontCameraMirrored) midBaseX - comX else comX - midBaseX
                val leftBias = (50f + (signedShift / baseWidth) * 100f).coerceIn(0f, 100f)

                frame.copy(
                    landmarks = lm,
                    comX = comX,
                    comY = comY,
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
        prevPeakIdx: Int,
        peakIdx: Int,
        is30s: Boolean = false
    ): SingleTrialMetrics {
        val peakHipY = hipY[peakIdx]
        val subSlice = hipY.subList(prevPeakIdx, peakIdx + 1)
        val maxLocalSitY = subSlice.maxOrNull() ?: hipY[peakIdx]
        val excursion = max(0.02f, maxLocalSitY - peakHipY)

        // 立ち上がり直前の「着座底（最下点）」を立位ピークから後方探索（失敗試行に引きずられない）
        var localBottomIdx = peakIdx
        for (i in peakIdx downTo prevPeakIdx) {
            if (hipY[i] >= maxLocalSitY - excursion * 0.08f) {
                localBottomIdx = i
                break
            }
        }

        val baselineShoulderY = shoulderY.subList(localBottomIdx, peakIdx + 1).maxOrNull() ?: shoulderY[peakIdx]
        val shoulderExcursion = max(0.02f, baselineShoulderY - shoulderY[peakIdx])

        // 着座底からの動き出し（体幹前傾または腰部浮上開始）を成功立ち上がりの開始点と同定
        var startIdx = localBottomIdx
        for (i in localBottomIdx until peakIdx) {
            val hipMoved = (maxLocalSitY - hipY[i]) >= excursion * 0.08f
            val trunkLeaned = (baselineShoulderY - shoulderY[i]) >= shoulderExcursion * 0.12f
            if (hipMoved || trunkLeaned) {
                startIdx = i
                break
            }
        }

        // 離臀（Excursionの20%浮上）
        var seatOffIdx = startIdx
        for (i in startIdx..peakIdx) {
            if ((maxLocalSitY - hipY[i]) >= excursion * 0.20f) {
                seatOffIdx = i
                break
            }
        }

        // 立ち上がり完了（Excursionの90%到達）
        var standEndIdx = peakIdx
        val targetStandY = maxLocalSitY - excursion * 0.90f
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

        val actualStableMs = if (is30s) frames[standEndIdx].timestampMs else frames[stableIdx].timestampMs

        return recalculateTrialFromTimestamps(
            repIndex = repIndex,
            frames = frames,
            startTimeMs = frames[startIdx].timestampMs,
            seatOffTimeMs = frames[seatOffIdx].timestampMs,
            standEndTimeMs = frames[standEndIdx].timestampMs,
            stableTimeMs = actualStableMs
        )
    }

    private fun detectFailedAttempts(
        hipY: List<Float>,
        frames: List<PoseFrameData>,
        standingPeakIndices: List<Int>,
        sitHipY: Float,
        standHipY: Float
    ): List<FailedAttempt> {
        val overallExcursion = max(0.03f, sitHipY - standHipY)
        val detected = mutableListOf<FailedAttempt>()

        for (repIdx in standingPeakIndices.indices) {
            val peakIdx = standingPeakIndices[repIdx]
            val prevPeak = if (repIdx == 0) 0 else standingPeakIndices[repIdx - 1]

            // この立ち上がりの直前の着座底を探す
            var bottomIdx = peakIdx
            for (i in peakIdx downTo prevPeak) {
                if (hipY[i] >= sitHipY - overallExcursion * 0.08f) {
                    bottomIdx = i
                    break
                }
            }

            // prevPeak と bottomIdx の間のインターバル区間に、失敗した小山（離臀失敗）があるか探索
            if (bottomIdx > prevPeak + 8) {
                for (i in (prevPeak + 4) until (bottomIdx - 4)) {
                    if (hipY[i] <= hipY[i - 1] && hipY[i] <= hipY[i + 1] &&
                        hipY[i] <= hipY[i - 2] && hipY[i] <= hipY[i + 2]) {
                        val lift = sitHipY - hipY[i]
                        // 座位から一定以上浮いたが立位(70%)に届かなかったもの＝離臀失敗
                        if (lift >= overallExcursion * 0.15f && lift < overallExcursion * 0.70f) {
                            detected.add(FailedAttempt(timestampMs = frames[i].timestampMs, note = "離臀失敗"))
                        }
                    }
                }
            }
        }
        return detected.distinctBy { it.timestampMs / 500L }
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
        frames: List<PoseFrameData>,
        hipY: List<Float>,
        sitY: Float,
        standY: Float,
        expectedCount: Int
    ): List<Int> {
        val range = max(0.03f, sitY - standY)
        val candidateThresholdY = sitY - range * 0.65f
        val minSeparationIndices = max(4, estimateWindowFrames(frames, targetMs = 650L))

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
        return if (expectedCount > 0 && candidates.size > expectedCount) {
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

    private fun averageY(vararg pts: Point2D?): Float? {
        val valid = pts.filterNotNull()
        return if (valid.isEmpty()) null else valid.map { it.y }.average().toFloat()
    }
}
