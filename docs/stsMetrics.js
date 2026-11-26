/**
 * STS Biomechanical Calculation Engine
 * Faithful port from StsMetricCalculator.kt
 */

import {
  StsMode,
  Point2D,
  Point3D,
  TimingBias,
  GrfSample,
  PoseFrameData,
  FailedAttempt,
  SingleTrialMetrics,
  StsAnalysisResult,
  SubjectAnthropometrics
} from "./stsModels.js?v=20261126_5";

const GRAVITY = 9.80665;
const TRACKED_INDICES = [11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];

export class StsMetricCalculator {

  static calculate({
    rawFrames,
    mode,
    anthropometrics = new SubjectAnthropometrics(),
    isFrontCameraMirrored = false,
    customThirtySecReps = null
  }) {
    if (!rawFrames || rawFrames.length < 5) {
      throw new Error("解析に十分なフレーム数がありません（最低5フレーム必要）。");
    }

    // 1. 欠損値補間 & 重心再計算
    const baseFrames = this.interpolateAndRecomputeCom(rawFrames, isFrontCameraMirrored);

    // 2. 推定床反力（GRF）付与
    const framesWithGrf = this.attachEstimatedGrf(baseFrames, anthropometrics, isFrontCameraMirrored);

    // 3. 骨盤・肩の Y 座標軌跡抽出 & 平滑化
    const rawHipY = framesWithGrf.map(frame => {
      const lHip = frame.landmarks[23]?.y ?? 0.55;
      const rHip = frame.landmarks[24]?.y ?? 0.55;
      return (lHip + rHip) / 2.0;
    });
    const rawShoulderY = framesWithGrf.map(frame => {
      const lSh = frame.landmarks[11]?.y ?? 0.30;
      const rSh = frame.landmarks[12]?.y ?? 0.30;
      return (lSh + rSh) / 2.0;
    });

    const hipY = this.movingAverage(rawHipY, 5);
    const shoulderY = this.movingAverage(rawShoulderY, 5);

    const standHipY = Math.min(...hipY);
    const sitHipY = Math.max(...hipY);

    const is30s = mode.id === "THIRTY_SECONDS";
    const expectedCount = is30s
      ? (customThirtySecReps != null ? Math.max(1, Math.min(60, customThirtySecReps)) : 10)
      : mode.targetReps;

    const allCandidates = this.findRisingPeaks(framesWithGrf, hipY, sitHipY, standHipY, 0);

    let standingPeakIndices = [];
    if (is30s) {
      if (customThirtySecReps != null && customThirtySecReps > 0) {
        const targetN = Math.max(1, Math.min(60, customThirtySecReps));
        if (allCandidates.length >= targetN) {
          standingPeakIndices = allCandidates.slice(0, targetN);
        } else {
          const supplemented = [...allCandidates];
          const lastIdx = framesWithGrf.length - 1;
          const baseStep = supplemented.length >= 2
            ? Math.max(12, Math.floor((supplemented[supplemented.length - 1] - supplemented[0]) / (supplemented.length - 1)))
            : Math.max(15, Math.floor(framesWithGrf.length / (targetN + 1)));

          while (supplemented.length < targetN) {
            const nextIdx = Math.min(lastIdx - 4, (supplemented[supplemented.length - 1] ?? 10) + baseStep);
            supplemented.push(nextIdx);
          }
          standingPeakIndices = supplemented.sort((a, b) => a - b);
        }
      } else {
        standingPeakIndices = allCandidates.length > 0 ? allCandidates : [Math.floor(framesWithGrf.length / 2)];
      }
    } else {
      if (expectedCount > 0 && allCandidates.length > expectedCount) {
        standingPeakIndices = [...allCandidates]
          .sort((a, b) => hipY[a] - hipY[b])
          .slice(0, expectedCount)
          .sort((a, b) => a - b);
      } else {
        standingPeakIndices = allCandidates;
      }
    }

    const rawTrials = standingPeakIndices.map((peakIdx, repIdx) => {
      const prevPeak = repIdx === 0 ? 0 : standingPeakIndices[repIdx - 1];
      return this.buildSingleTrialMetrics({
        repIndex: repIdx + 1,
        frames: framesWithGrf,
        hipY,
        shoulderY,
        prevPeakIdx: prevPeak,
        peakIdx,
        is30s
      });
    });

    // 30秒立ち座りの場合、第1回開始時刻から30.0秒以内に終了した試行のみ含める
    // （6回目など、1回目開始から30秒を経過している試行は含めない）
    const trials = (is30s && rawTrials.length > 0)
      ? (() => {
          const t0 = rawTrials[0].startTimeMs;
          return rawTrials.filter(t => t.standEndTimeMs <= t0 + 30000);
        })()
      : rawTrials;

    const autoFailedAttempts = this.detectFailedAttempts(
      hipY,
      framesWithGrf,
      standingPeakIndices,
      sitHipY,
      standHipY
    );

    let overallTotalSec = null;
    if (mode.id === "SINGLE" && trials.length > 0) {
      overallTotalSec = trials[0].totalDurationSec;
    } else if (mode.id === "FIVE_TIMES" && trials.length > 0) {
      const lastTrial = trials[Math.min(trials.length - 1, 4)];
      overallTotalSec = Math.max(0, (lastTrial.stableTimeMs - trials[0].startTimeMs) / 1000.0);
    } else if (mode.id === "THIRTY_SECONDS" && trials.length > 0) {
      const t0 = trials[0].startTimeMs;
      const lastTime = trials[trials.length - 1].standEndTimeMs;
      overallTotalSec = Math.min(30.0, Math.max(0, (lastTime - t0) / 1000.0));
    }

    return new StsAnalysisResult({
      mode,
      anthropometrics,
      trials,
      overallTotalDurationSec: overallTotalSec,
      frames: framesWithGrf,
      isFrontCameraMirrored,
      failedAttempts: autoFailedAttempts
    });
  }

  /**
   * 30秒立ち座りにおいて、動画確認後に指定された立ち上がり総数（newCount）に合わせて試行枠を調整
   */
  static adjustTrialsCount(currentResult, newCount) {
    const targetN = Math.max(1, Math.min(60, newCount));
    const frames = currentResult.frames;
    const existingTrials = currentResult.trials;
    if (existingTrials.length === targetN || frames.length === 0) return currentResult;

    if (existingTrials.length > targetN) {
      const trimmed = existingTrials.slice(0, targetN);
      const t0 = trimmed[0].startTimeMs;
      const lastEnd = trimmed[trimmed.length - 1].standEndTimeMs;
      const overallSec = Math.min(30.0, Math.max(0, (lastEnd - t0) / 1000.0));
      return new StsAnalysisResult({
        ...currentResult,
        trials: trimmed,
        overallTotalDurationSec: overallSec
      });
    }

    const addedTrials = [];
    const rawHipY = frames.map(f => ((f.landmarks[23]?.y ?? 0.55) + (f.landmarks[24]?.y ?? 0.55)) / 2.0);
    const hipY = this.movingAverage(rawHipY, 5);
    const rawShoulderY = frames.map(f => ((f.landmarks[11]?.y ?? 0.30) + (f.landmarks[12]?.y ?? 0.30)) / 2.0);
    const shoulderY = this.movingAverage(rawShoulderY, 5);

    const standHipY = Math.min(...hipY);
    const sitHipY = Math.max(...hipY);

    const allPeaks = this.findRisingPeaks(frames, hipY, sitHipY, standHipY, 0);
    const existingEndMs = existingTrials.length > 0 ? existingTrials[existingTrials.length - 1].standEndTimeMs : 0;
    const remainingPeaks = allPeaks.filter(idx => frames[idx].timestampMs > existingEndMs + 300);

    let curRep = existingTrials.length + 1;
    let peakIdxInRemaining = 0;

    while (curRep <= targetN) {
      const combined = [...existingTrials, ...addedTrials];
      if (peakIdxInRemaining < remainingPeaks.length) {
        const peakIdx = remainingPeaks[peakIdxInRemaining];
        const prevPeak = combined.length === 0 ? 0 : (() => {
          const prevTrial = combined[combined.length - 1];
          const found = frames.findIndex(f => f.timestampMs >= prevTrial.standEndTimeMs);
          return found >= 0 ? found : 0;
        })();
        const trial = this.buildSingleTrialMetrics({
          repIndex: curRep,
          frames,
          hipY,
          shoulderY,
          prevPeakIdx: prevPeak,
          peakIdx,
          is30s: true
        });
        addedTrials.push(trial);
        peakIdxInRemaining++;
      } else {
        const prevTrial = combined.length > 0 ? combined[combined.length - 1] : null;
        const dt = prevTrial ? Math.max(1000, prevTrial.standEndTimeMs - prevTrial.startTimeMs) : 2000;
        const baseTime = prevTrial ? prevTrial.standEndTimeMs : frames[0].timestampMs;
        const newStart = Math.min(frames[frames.length - 1].timestampMs - 400, baseTime + 200);
        const newSeat = Math.min(frames[frames.length - 1].timestampMs - 200, newStart + Math.floor(dt / 3));
        const newEnd = Math.min(frames[frames.length - 1].timestampMs, newStart + dt);
        const trial = this.recalculateTrialFromTimestamps({
          repIndex: curRep,
          frames,
          startTimeMs: newStart,
          seatOffTimeMs: newSeat,
          standEndTimeMs: newEnd,
          stableTimeMs: newEnd
        });
        addedTrials.push(trial);
      }
      curRep++;
    }

    const allTrials = [...existingTrials, ...addedTrials];
    // 30秒ウィンドウ制限
    const validTrials = allTrials.length > 0 ? (() => {
      const t0 = allTrials[0].startTimeMs;
      return allTrials.filter(t => t.standEndTimeMs <= t0 + 30000);
    })() : allTrials;

    const t0 = validTrials.length > 0 ? validTrials[0].startTimeMs : 0;
    const lastEnd = validTrials.length > 0 ? validTrials[validTrials.length - 1].standEndTimeMs : 0;
    const overallSec = validTrials.length > 0 ? Math.min(30.0, Math.max(0, (lastEnd - t0) / 1000.0)) : 0;

    return new StsAnalysisResult({
      ...currentResult,
      trials: validTrials,
      overallTotalDurationSec: overallSec
    });
  }

  static recalculateTrialFromTimestamps({
    repIndex,
    frames,
    startTimeMs,
    seatOffTimeMs,
    standEndTimeMs,
    stableTimeMs
  }) {
    const t0 = Math.min(startTimeMs, seatOffTimeMs);
    const t1 = Math.max(t0, Math.min(seatOffTimeMs, standEndTimeMs));
    const t2 = Math.max(t1, Math.min(standEndTimeMs, stableTimeMs));
    const t3 = Math.max(t2, stableTimeMs);

    const fStart = this.nearestFrame(frames, t0);
    const fSeat = this.nearestFrame(frames, t1);
    const fStand = this.nearestFrame(frames, t2);
    const fStable = this.nearestFrame(frames, t3);

    const startIdx = Math.max(0, frames.indexOf(fStart));
    const seatIdx = Math.max(startIdx, frames.indexOf(fSeat));
    const standIdx = Math.max(seatIdx, frames.indexOf(fStand));
    const stableIdx = Math.max(standIdx, frames.indexOf(fStable));

    const meanSlice = frames.slice(startIdx, Math.min(frames.length, stableIdx + 1));
    const meanLeft = meanSlice.length > 0
      ? meanSlice.reduce((sum, f) => sum + f.leftBiasPercent, 0) / meanSlice.length
      : 50.0;

    // 床反力は離臀から立ち上がり完了までの間のピーク値を算出
    const grfSlice = frames.slice(seatIdx, Math.min(frames.length, standIdx + 1))
      .map(f => f.grf)
      .filter(Boolean);

    const peakVertBw = grfSlice.length > 0 ? Math.max(...grfSlice.map(g => g.verticalPercentBw)) : 100.0;
    const peakVertN = grfSlice.length > 0 ? Math.max(...grfSlice.map(g => g.verticalNewton)) : 0.0;
    const minVertBw = grfSlice.length > 0 ? Math.min(...grfSlice.map(g => g.verticalPercentBw)) : 100.0;
    const minVertN = grfSlice.length > 0 ? Math.min(...grfSlice.map(g => g.verticalNewton)) : 0.0;

    const peakLatLeftBw = grfSlice.length > 0 ? Math.max(...grfSlice.map(g => g.lateralPercentBw)) : 0.0;
    const peakLatLeftN = grfSlice.length > 0 ? Math.max(...grfSlice.map(g => g.lateralNewton)) : 0.0;
    const minLatValBw = grfSlice.length > 0 ? Math.min(...grfSlice.map(g => g.lateralPercentBw)) : 0.0;
    const minLatValN = grfSlice.length > 0 ? Math.min(...grfSlice.map(g => g.lateralNewton)) : 0.0;

    // --- 3D・矢状面 (Sagittal Plane) 新規指標算出 ---
    // 1. 離臀時の重心と支持基底面（足首マーカー）との前後距離 [cm]
    //    The ankle estimate wobbles by about 1-2 cm from frame to frame, so take the median CoM-ankle distance of the
    //    frames within ±100 ms of seat-off instead of the single seat-off frame. (comZ and midAnkleZ are hip-centred,
    //    so their difference, not the ankle position alone, is what stays comparable between frames.)
    const seatWindow = frames.filter(f => Math.abs(f.timestampMs - fSeat.timestampMs) <= 100)
      .map(f => f.comZ - f.midAnkleZ);
    const comAnkleApDistanceAtSeatOffCm = Math.max(0.5, Math.abs(this.median(seatWindow.length > 0 ? seatWindow : [fSeat.comZ - fSeat.midAnkleZ])) * 100.0);

    // 2. 前傾速度（開始〜離臀までの最大前傾角速度 [deg/s]）
    let maxPitchVel = 0.0;
    for (let i = startIdx + 1; i <= Math.max(startIdx + 1, seatIdx); i++) {
      const dt = Math.max(0.008, (frames[i].timestampMs - frames[i - 1].timestampMs) / 1000.0);
      const dPitch = frames[i].trunkAngleDeg - frames[i - 1].trunkAngleDeg;
      const pitchVel = dPitch / dt;
      if (pitchVel > maxPitchVel) maxPitchVel = pitchVel;
    }
    // もし滑らかさ等の関係でゼロに近い場合は、開始〜離臀での平均角速度または代表値
    if (maxPitchVel <= 1.0 && seatIdx > startIdx) {
      const totalDt = Math.max(0.1, (fSeat.timestampMs - fStart.timestampMs) / 1000.0);
      const diffPitch = Math.max(0, fSeat.trunkAngleDeg - fStart.trunkAngleDeg);
      maxPitchVel = (diffPitch / totalDt) * 1.35; // ピーク推定
    }

    // 3. 離臀時およびそれ以降の前後床反力ピーク (AP-GRF) [%BW, N]
    const peakApPropBw = grfSlice.length > 0 ? Math.max(...grfSlice.map(g => g.apPropulsionPercentBw)) : 0.0;
    const peakApPropN = grfSlice.length > 0 ? Math.max(...grfSlice.map(g => g.apPropulsionNewton)) : 0.0;
    const peakApBrakeBw = grfSlice.length > 0 ? Math.max(...grfSlice.map(g => g.apBrakingPercentBw)) : 0.0;
    const peakApBrakeN = grfSlice.length > 0 ? Math.max(...grfSlice.map(g => g.apBrakingNewton)) : 0.0;

    // 4. その他の矢状面指標（最大体幹前傾角、股関節最大屈曲角、膝ROM、前後CoM移動量）
    const trialFrames = frames.slice(startIdx, Math.min(frames.length, standIdx + 1));
    const trunkAngles = trialFrames.map(f => f.trunkAngleDeg);
    const hipAngles = trialFrames.map(f => f.hipAngleDeg);
    const kneeAngles = trialFrames.map(f => f.kneeAngleDeg);
    const comZs = trialFrames.map(f => f.comZ * 100.0);

    const maxTrunkFlexionDeg = trunkAngles.length > 0 ? Math.max(...trunkAngles) : 0.0;
    const maxHipFlexionDeg = hipAngles.length > 0 ? Math.max(...hipAngles) : 0.0;
    const kneeMax = kneeAngles.length > 0 ? Math.max(...kneeAngles) : 90.0;
    const kneeMin = kneeAngles.length > 0 ? Math.min(...kneeAngles) : 10.0;
    const kneeRomDeg = Math.max(0.0, kneeMax - kneeMin);
    const totalApComExcursionCm = comZs.length > 0 ? Math.max(0.0, Math.max(...comZs) - Math.min(...comZs)) : 0.0;

    return new SingleTrialMetrics({
      repIndex,
      startTimeMs: fStart.timestampMs,
      seatOffTimeMs: fSeat.timestampMs,
      standEndTimeMs: fStand.timestampMs,
      stableTimeMs: fStable.timestampMs,
      totalDurationSec: Math.max(0, (fStable.timestampMs - fStart.timestampMs) / 1000.0),
      seatOffDurationSec: Math.max(0, (fSeat.timestampMs - fStart.timestampMs) / 1000.0),
      risingDurationSec: Math.max(0, (fStand.timestampMs - fSeat.timestampMs) / 1000.0),
      stabilizationDurationSec: Math.max(0, (fStable.timestampMs - fStand.timestampMs) / 1000.0),
      biasAtStart: this.toTimingBias(fStart),
      biasAtSeatOff: this.toTimingBias(fSeat),
      biasAtStandEnd: this.toTimingBias(fStand),
      biasAtStable: this.toTimingBias(fStable),
      meanLeftBiasPercent: meanLeft,
      peakVerticalBwPercent: peakVertBw,
      peakVerticalNewton: peakVertN,
      minVerticalBwPercent: minVertBw,
      minVerticalNewton: minVertN,
      peakLateralLeftBwPercent: Math.max(0, peakLatLeftBw),
      peakLateralLeftNewton: Math.max(0, peakLatLeftN),
      peakLateralRightBwPercent: Math.abs(Math.min(0, minLatValBw)),
      peakLateralRightNewton: Math.abs(Math.min(0, minLatValN)),
      // 3D・矢状面
      comAnkleApDistanceAtSeatOffCm: Math.round(comAnkleApDistanceAtSeatOffCm * 10) / 10,
      peakForwardPitchVelocityDegPerSec: Math.round(maxPitchVel * 10) / 10,
      peakApGrfPropulsionPercentBw: Math.round(peakApPropBw * 10) / 10,
      peakApGrfPropulsionNewton: Math.round(peakApPropN),
      peakApGrfBrakingPercentBw: Math.round(peakApBrakeBw * 10) / 10,
      peakApGrfBrakingNewton: Math.round(peakApBrakeN),
      maxTrunkFlexionDeg: Math.round(maxTrunkFlexionDeg * 10) / 10,
      maxHipFlexionDeg: Math.round(maxHipFlexionDeg * 10) / 10,
      kneeRomDeg: Math.round(kneeRomDeg * 10) / 10,
      totalApComExcursionCm: Math.round(totalApComExcursionCm * 10) / 10
    });
  }

  static attachEstimatedGrf(frames, anthropometrics, isFrontCameraMirrored) {
    const massKg = Math.max(20.0, Math.min(250.0, anthropometrics.weightKg));
    const heightMeters = Math.max(100.0, Math.min(240.0, anthropometrics.heightCm)) / 100.0;

    let minTopY = 0.15;
    let maxFootY = 0.90;

    const tops = frames.map(f => {
      const vals = [f.landmarks[0]?.y, f.landmarks[11]?.y, f.landmarks[12]?.y].filter(v => v != null);
      return vals.length > 0 ? Math.min(...vals) : null;
    }).filter(v => v != null);
    if (tops.length > 0) minTopY = Math.min(...tops);

    const bottoms = frames.map(f => {
      const vals = [f.landmarks[27]?.y, f.landmarks[28]?.y, f.landmarks[29]?.y, f.landmarks[30]?.y].filter(v => v != null);
      return vals.length > 0 ? Math.max(...vals) : null;
    }).filter(v => v != null);
    if (bottoms.length > 0) maxFootY = Math.max(...bottoms);

    const estimatedStandingNormHeight = Math.max(0.30, (maxFootY - minTopY) * 1.12);
    const metersPerNormUnit = heightMeters / estimatedStandingNormHeight;

    const smoothComX = this.movingAverage(frames.map(f => f.comX), 7);
    const smoothComY = this.movingAverage(frames.map(f => f.comY), 7);
    const smoothComZ = this.movingAverage(frames.map(f => f.comZ), 7);

    const vx = new Array(frames.length).fill(0);
    const vyUpward = new Array(frames.length).fill(0);
    const vzForward = new Array(frames.length).fill(0);

    for (let i = 1; i < frames.length; i++) {
      const dtSec = Math.max(0.008, (frames[i].timestampMs - frames[i - 1].timestampMs) / 1000.0);
      const dxMeters = (smoothComX[i] - smoothComX[i - 1]) * metersPerNormUnit;
      const dyUpMeters = -(smoothComY[i] - smoothComY[i - 1]) * metersPerNormUnit;
      const dzMeters = smoothComZ[i] - smoothComZ[i - 1];
      vx[i] = dxMeters / dtSec;
      vyUpward[i] = dyUpMeters / dtSec;
      vzForward[i] = dzMeters / dtSec;
    }

    const smoothVx = this.movingAverage(vx, 5);
    const smoothVy = this.movingAverage(vyUpward, 5);
    const smoothVz = this.movingAverage(vzForward, 5);

    const ax = new Array(frames.length).fill(0);
    const ayUpward = new Array(frames.length).fill(0);
    const azForward = new Array(frames.length).fill(0);

    for (let i = 1; i < frames.length; i++) {
      const dtSec = Math.max(0.008, (frames[i].timestampMs - frames[i - 1].timestampMs) / 1000.0);
      ax[i] = Math.max(-15.0, Math.min(15.0, (smoothVx[i] - smoothVx[i - 1]) / dtSec));
      ayUpward[i] = Math.max(-15.0, Math.min(15.0, (smoothVy[i] - smoothVy[i - 1]) / dtSec));
      azForward[i] = Math.max(-15.0, Math.min(15.0, (smoothVz[i] - smoothVz[i - 1]) / dtSec));
    }

    const smoothAx = this.movingAverage(ax, 5);
    const smoothAy = this.movingAverage(ayUpward, 5);
    const smoothAz = this.movingAverage(azForward, 5);

    return frames.map((frame, i) => {
      const signedAxLeft = isFrontCameraMirrored ? -smoothAx[i] : smoothAx[i];
      const ay = smoothAy[i];
      const az = smoothAz[i];

      const verticalN = Math.max(0, massKg * (GRAVITY + ay));
      const verticalBw = Math.max(0, (1.0 + ay / GRAVITY) * 100.0);

      const lateralN = massKg * signedAxLeft;
      const lateralBw = (signedAxLeft / GRAVITY) * 100.0;

      // 前後床反力: 前方加速（推進）と後方減速（制動）
      const apPropBw = Math.max(0, (az / GRAVITY) * 100.0);
      const apPropN = Math.max(0, massKg * az);
      const apBrakeBw = Math.max(0, (-az / GRAVITY) * 100.0);
      const apBrakeN = Math.max(0, massKg * -az);

      return new PoseFrameData({
        ...frame,
        // Whole-body GRF vector [N] in the worldLandmarks axes: x = image right, y = up, z = away from the camera
        grfVector: { x: massKg * smoothAx[i], y: verticalN, z: massKg * az },
        grf: new GrfSample(
          verticalBw,
          verticalN,
          lateralBw,
          lateralN,
          apPropBw,
          apPropN,
          apBrakeBw,
          apBrakeN
        )
      });
    });
  }

  static interpolateAndRecomputeCom(rawFrames, isFrontCameraMirrored) {
    const meshComs = this.interpolateMeshCom(rawFrames);
    const mutableLandmarks = rawFrames.map(f => ({ ...f.landmarks }));
    const mutableWorldLm = rawFrames.map(f => ({ ...(f.worldLandmarks || {}) }));

    for (const idx of TRACKED_INDICES) {
      // 1. 2D & 3D 異常ジャンプ（外れ値）の除去
      for (let f = 1; f < rawFrames.length; f++) {
        const prev = mutableLandmarks[f - 1][idx];
        const curr = mutableLandmarks[f][idx];
        if (prev && curr) {
          const dist = Math.hypot(curr.x - prev.x, curr.y - prev.y);
          if (dist > 0.16) {
            delete mutableLandmarks[f][idx];
          }
        }
      }

      // 2. 欠損値の線形補間 (2D & 3D)
      for (let f = 0; f < rawFrames.length; f++) {
        if (!mutableLandmarks[f][idx]) {
          let prevValid = f - 1;
          while (prevValid >= 0 && !mutableLandmarks[prevValid][idx]) prevValid--;
          let nextValid = f + 1;
          while (nextValid < rawFrames.length && !mutableLandmarks[nextValid][idx]) nextValid++;

          const pPrev = prevValid >= 0 ? mutableLandmarks[prevValid][idx] : null;
          const pNext = nextValid < rawFrames.length ? mutableLandmarks[nextValid][idx] : null;

          if (pPrev && pNext) {
            const ratio = (f - prevValid) / Math.max(1, nextValid - prevValid);
            mutableLandmarks[f][idx] = new Point2D(
              pPrev.x + (pNext.x - pPrev.x) * ratio,
              pPrev.y + (pNext.y - pPrev.y) * ratio
            );
          } else if (pPrev) {
            mutableLandmarks[f][idx] = pPrev;
          } else if (pNext) {
            mutableLandmarks[f][idx] = pNext;
          }
        }

        if (!mutableWorldLm[f][idx]) {
          let prevValid = f - 1;
          while (prevValid >= 0 && !mutableWorldLm[prevValid][idx]) prevValid--;
          let nextValid = f + 1;
          while (nextValid < rawFrames.length && !mutableWorldLm[nextValid][idx]) nextValid++;

          const wpPrev = prevValid >= 0 ? mutableWorldLm[prevValid][idx] : null;
          const wpNext = nextValid < rawFrames.length ? mutableWorldLm[nextValid][idx] : null;

          if (wpPrev && wpNext) {
            const ratio = (f - prevValid) / Math.max(1, nextValid - prevValid);
            mutableWorldLm[f][idx] = new Point3D(
              wpPrev.x + (wpNext.x - wpPrev.x) * ratio,
              wpPrev.y + (wpNext.y - wpPrev.y) * ratio,
              wpPrev.z + (wpNext.z - wpPrev.z) * ratio
            );
          } else if (wpPrev) {
            mutableWorldLm[f][idx] = wpPrev;
          } else if (wpNext) {
            mutableWorldLm[f][idx] = wpNext;
          }
        }
      }
    }

    return rawFrames.map((frame, i) => {
      const lm = mutableLandmarks[i];
      const wlm = mutableWorldLm[i];

      const lShoulder = lm[11];
      const rShoulder = lm[12];
      const lHip = lm[23];
      const rHip = lm[24];

      if (!lShoulder || !rShoulder || !lHip || !rHip) {
        return frame;
      }

      const lFootX = this.averageX(lm[27], lm[29], lm[31]) ?? lHip.x;
      const rFootX = this.averageX(lm[28], lm[30], lm[32]) ?? rHip.x;
      const midBaseX = (lFootX + rFootX) / 2.0;
      const pelvisWidth = Math.abs(lHip.x - rHip.x);
      const baseWidth = Math.max(Math.abs(lFootX - rFootX), Math.max(0.06, pelvisWidth * 0.8));

      const midShoulderX = (lShoulder.x + rShoulder.x) / 2.0;
      const midHipX = (lHip.x + rHip.x) / 2.0;
      const midFootX = (lFootX + rFootX) / 2.0;
      const meshCom = meshComs ? meshComs[i] : null;
      // Mesh CoM (InstantHMR) when available; otherwise a 3-point weighted estimate from the landmarks
      const comX = meshCom?.image ? meshCom.image.x : 0.30 * midShoulderX + 0.40 * midHipX + 0.30 * midFootX;

      const midShoulderY = (lShoulder.y + rShoulder.y) / 2.0;
      const midHipY = (lHip.y + rHip.y) / 2.0;
      const lFootY = this.averageY(lm[27], lm[29], lm[31]) ?? lHip.y;
      const rFootY = this.averageY(lm[28], lm[30], lm[32]) ?? rHip.y;
      const midFootY = (lFootY + rFootY) / 2.0;
      const comY = meshCom?.image ? meshCom.image.y : 0.30 * midShoulderY + 0.40 * midHipY + 0.30 * midFootY;

      const signedShift = isFrontCameraMirrored ? midBaseX - comX : comX - midBaseX;
      const leftBias = Math.max(0, Math.min(100, 50.0 + (signedShift / baseWidth) * 100.0));

      // --- 3D World Landmarks 生体力学計算 ---
      const wLSh = wlm[11];
      const wRSh = wlm[12];
      const wLHip = wlm[23];
      const wRHip = wlm[24];
      const wLKnee = wlm[25];
      const wRKnee = wlm[26];
      const wLAnk = wlm[27];
      const wRAnk = wlm[28];

      let comZ = 0.0;
      let midAnkleZ = 0.0;
      let trunkAngleDeg = 0.0;
      let hipAngleDeg = 0.0;
      let kneeAngleDeg = 0.0;

      if (wLSh && wRSh && wLHip && wRHip) {
        const midSh3D = {
          x: (wLSh.x + wRSh.x) / 2,
          y: (wLSh.y + wRSh.y) / 2,
          z: (wLSh.z + wRSh.z) / 2
        };
        const midHip3D = {
          x: (wLHip.x + wRHip.x) / 2,
          y: (wLHip.y + wRHip.y) / 2,
          z: (wLHip.z + wRHip.z) / 2
        };
        const midKnee3D = (wLKnee && wRKnee) ? {
          x: (wLKnee.x + wRKnee.x) / 2,
          y: (wLKnee.y + wRKnee.y) / 2,
          z: (wLKnee.z + wRKnee.z) / 2
        } : midHip3D;

        const midAnk3D = (wLAnk && wRAnk) ? {
          x: (wLAnk.x + wRAnk.x) / 2,
          y: (wLAnk.y + wRAnk.y) / 2,
          z: (wLAnk.z + wRAnk.z) / 2
        } : midKnee3D;

        midAnkleZ = midAnk3D.z;
        comZ = meshCom?.world ? meshCom.world.z : 0.35 * midSh3D.z + 0.35 * midHip3D.z + 0.30 * midAnk3D.z;

        const dyTrunk = Math.abs(midSh3D.y - midHip3D.y);
        const dzTrunk = Math.abs(midSh3D.z - midHip3D.z);
        trunkAngleDeg = Math.atan2(dzTrunk, Math.max(0.01, dyTrunk)) * (180.0 / Math.PI);

        const vTrunk = [0, -(midSh3D.y - midHip3D.y), -(midSh3D.z - midHip3D.z)];
        const vThigh = [0, midKnee3D.y - midHip3D.y, midKnee3D.z - midHip3D.z];
        hipAngleDeg = this.calculateAngleBetweenVectors(vTrunk, vThigh);

        const vThighInv = [0, midHip3D.y - midKnee3D.y, midHip3D.z - midKnee3D.z];
        const vShank = [0, midAnk3D.y - midKnee3D.y, midAnk3D.z - midKnee3D.z];
        const kneeExtAngle = this.calculateAngleBetweenVectors(vThighInv, vShank);
        kneeAngleDeg = Math.max(0, 180.0 - kneeExtAngle);
      } else {
        const dyTrunk2D = Math.abs(midShoulderY - midHipY);
        trunkAngleDeg = Math.max(0, Math.min(60, (0.35 - dyTrunk2D) * 120.0));
        comZ = (midShoulderY - 0.4) * 0.2;
        midAnkleZ = 0.0;
      }

      return new PoseFrameData({
        ...frame,
        landmarks: lm,
        worldLandmarks: wlm,
        comX,
        comY,
        comZ,
        midBaseX,
        midAnkleZ,
        baseWidth,
        leftBiasPercent: leftBias,
        rightBiasPercent: 100.0 - leftBias,
        trunkAngleDeg,
        hipAngleDeg,
        kneeAngleDeg,
        meshCom
      });
    });
  }

  /**
   * Mesh CoM per frame with gaps (frames where the mesh estimator failed) filled by linear interpolation,
   * so the CoM does not jump between the mesh and the landmark estimate. Null when no frame has a mesh CoM.
   */
  static interpolateMeshCom(rawFrames) {
    if (!rawFrames.some(f => f.meshCom)) return null;
    const lerp = (a, b, t) => (a && b) ? { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, ...(a.z != null ? { z: a.z + (b.z - a.z) * t } : {}) } : (a || b || null);
    const out = rawFrames.map(f => f.meshCom || null);
    for (const key of ["world", "image"]) {
      const has = out.map(c => !!(c && c[key]));
      for (let f = 0; f < out.length; f++) {
        if (has[f]) continue;
        let p = f - 1; while (p >= 0 && !has[p]) p--;
        let n = f + 1; while (n < out.length && !has[n]) n++;
        const a = p >= 0 ? out[p][key] : null, b = n < out.length ? out[n][key] : null;
        if (!a && !b) continue;
        const t = (a && b) ? (f - p) / (n - p) : 0;
        out[f] = { ...(out[f] || {}), [key]: lerp(a, b, t) };
      }
    }
    return out;
  }

  /**
   * Zero-phase Gaussian smoothing of the per-frame input (2D and 3D landmarks, mesh CoM) over time, sigma in ms.
   * Each landmark is averaged over the neighbouring frames that have it. sigma <= 0 returns the frames unchanged.
   */
  static smoothFrames(rawFrames, sigmaMs) {
    if (!rawFrames || !(sigmaMs > 0)) return rawFrames;
    const t = rawFrames.map(f => f.timestampMs);
    const reach = 3 * sigmaMs;
    const avgPoints = (i, get, make) => {
      const keys = Object.keys(get(rawFrames[i]) || {});
      const out = {};
      for (const k of keys) {
        let sx = 0, sy = 0, sz = 0, sw = 0, hasZ = false;
        for (let j = i; j >= 0 && t[i] - t[j] <= reach; j--) add(j);
        for (let j = i + 1; j < rawFrames.length && t[j] - t[i] <= reach; j++) add(j);
        function add(j) {
          const p = (get(rawFrames[j]) || {})[k];
          if (!p) return;
          const d = (t[j] - t[i]) / sigmaMs, w = Math.exp(-0.5 * d * d);
          sx += w * p.x; sy += w * p.y; sw += w;
          if (p.z != null) { sz += w * p.z; hasZ = true; }
        }
        const p0 = get(rawFrames[i])[k];
        out[k] = make(sx / sw, sy / sw, hasZ ? sz / sw : undefined, p0);
      }
      return out;
    };
    return rawFrames.map((f, i) => {
      const landmarks = avgPoints(i, g => g.landmarks, (x, y) => new Point2D(x, y));
      const worldLandmarks = avgPoints(i, g => g.worldLandmarks, (x, y, z, p0) => new Point3D(x, y, z, p0.visibility));
      let meshCom = f.meshCom;
      if (meshCom) {
        const w = avgPoints(i, g => (g.meshCom && g.meshCom.world) ? { c: g.meshCom.world } : null, (x, y, z) => ({ x, y, z })).c;
        const im = avgPoints(i, g => (g.meshCom && g.meshCom.image) ? { c: g.meshCom.image } : null, (x, y) => ({ x, y })).c;
        meshCom = { ...meshCom, world: meshCom.world ? w : null, image: meshCom.image ? im : null };
      }
      return new PoseFrameData({ ...f, landmarks, worldLandmarks, meshCom });
    });
  }

  static median(values) {
    const a = [...values].sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  static calculateAngleBetweenVectors(v1, v2) {
    const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
    const mag1 = Math.hypot(v1[0], v1[1], v1[2]);
    const mag2 = Math.hypot(v2[0], v2[1], v2[2]);
    if (mag1 < 1e-4 || mag2 < 1e-4) return 0.0;
    const cosVal = Math.max(-1.0, Math.min(1.0, dot / (mag1 * mag2)));
    return Math.acos(cosVal) * (180.0 / Math.PI);
  }

  static buildSingleTrialMetrics({
    repIndex,
    frames,
    hipY,
    shoulderY,
    prevPeakIdx,
    peakIdx,
    is30s = false
  }) {
    const peakHipY = hipY[peakIdx];
    const subSlice = hipY.slice(prevPeakIdx, peakIdx + 1);
    const maxLocalSitY = subSlice.length > 0 ? Math.max(...subSlice) : hipY[peakIdx];
    const excursion = Math.max(0.02, maxLocalSitY - peakHipY);

    // 立ち上がり直前の着座底
    let localBottomIdx = peakIdx;
    for (let i = peakIdx; i >= prevPeakIdx; i--) {
      if (hipY[i] >= maxLocalSitY - excursion * 0.08) {
        localBottomIdx = i;
        break;
      }
    }

    const baselineShoulderY = Math.max(...shoulderY.slice(localBottomIdx, peakIdx + 1));
    const shoulderExcursion = Math.max(0.02, baselineShoulderY - shoulderY[peakIdx]);

    // 開始（動き出し）
    let startIdx = localBottomIdx;
    for (let i = localBottomIdx; i < peakIdx; i++) {
      const hipMoved = (maxLocalSitY - hipY[i]) >= excursion * 0.08;
      const trunkLeaned = (baselineShoulderY - shoulderY[i]) >= shoulderExcursion * 0.12;
      if (hipMoved || trunkLeaned) {
        startIdx = i;
        break;
      }
    }

    // 離臀（20%浮上）
    let seatOffIdx = startIdx;
    for (let i = startIdx; i <= peakIdx; i++) {
      if ((maxLocalSitY - hipY[i]) >= excursion * 0.20) {
        seatOffIdx = i;
        break;
      }
    }

    // 終了（90%伸展到達）
    let standEndIdx = peakIdx;
    const targetStandY = maxLocalSitY - excursion * 0.90;
    for (let i = seatOffIdx; i <= peakIdx; i++) {
      if (hipY[i] <= targetStandY) {
        standEndIdx = i;
        break;
      }
    }

    const lastIdx = frames.length - 1;
    const windowFrames = Math.max(2, this.estimateWindowFrames(frames, 300));
    let stableIdx = Math.min(lastIdx, standEndIdx + windowFrames);

    for (let i = standEndIdx; i <= lastIdx - windowFrames; i++) {
      const slice = frames.slice(i, i + windowFrames).map(f => f.leftBiasPercent);
      const spread = Math.max(...slice) - Math.min(...slice);
      if (spread <= 2.5) {
        stableIdx = i;
        break;
      }
    }
    stableIdx = Math.max(standEndIdx, Math.min(lastIdx, stableIdx));

    const actualStableMs = is30s ? frames[standEndIdx].timestampMs : frames[stableIdx].timestampMs;

    return this.recalculateTrialFromTimestamps({
      repIndex,
      frames,
      startTimeMs: frames[startIdx].timestampMs,
      seatOffTimeMs: frames[seatOffIdx].timestampMs,
      standEndTimeMs: frames[standEndIdx].timestampMs,
      stableTimeMs: actualStableMs
    });
  }

  static detectFailedAttempts(hipY, frames, standingPeakIndices, sitHipY, standHipY) {
    const overallExcursion = Math.max(0.03, sitHipY - standHipY);
    const detected = [];

    for (let repIdx = 0; repIdx < standingPeakIndices.length; repIdx++) {
      const peakIdx = standingPeakIndices[repIdx];
      const prevPeak = repIdx === 0 ? 0 : standingPeakIndices[repIdx - 1];

      let bottomIdx = peakIdx;
      for (let i = peakIdx; i >= prevPeak; i--) {
        if (hipY[i] >= sitHipY - overallExcursion * 0.08) {
          bottomIdx = i;
          break;
        }
      }

      if (bottomIdx > prevPeak + 8) {
        for (let i = prevPeak + 4; i < bottomIdx - 4; i++) {
          if (hipY[i] <= hipY[i - 1] && hipY[i] <= hipY[i + 1] &&
              hipY[i] <= hipY[i - 2] && hipY[i] <= hipY[i + 2]) {
            const lift = sitHipY - hipY[i];
            if (lift >= overallExcursion * 0.15 && lift < overallExcursion * 0.70) {
              detected.push(new FailedAttempt(frames[i].timestampMs, "離臀失敗"));
            }
          }
        }
      }
    }

    // 500ms以内の近接重複を除去
    const unique = [];
    const seenBucket = new Set();
    for (const fail of detected) {
      const bucket = Math.floor(fail.timestampMs / 500);
      if (!seenBucket.has(bucket)) {
        seenBucket.add(bucket);
        unique.push(fail);
      }
    }
    return unique;
  }

  static findRisingPeaks(frames, hipY, sitY, standY, expectedCount) {
    const range = Math.max(0.03, sitY - standY);
    const candidateThresholdY = sitY - range * 0.65;
    const minSeparationIndices = Math.max(4, this.estimateWindowFrames(frames, 650));

    const candidates = [];
    for (let i = 1; i < hipY.length - 1; i++) {
      if (hipY[i] <= candidateThresholdY && hipY[i] <= hipY[i - 1] && hipY[i] <= hipY[i + 1]) {
        if (candidates.length === 0 || i - candidates[candidates.length - 1] >= minSeparationIndices) {
          candidates.push(i);
        } else {
          const prevIdx = candidates[candidates.length - 1];
          if (hipY[i] < hipY[prevIdx]) {
            candidates[candidates.length - 1] = i;
          }
        }
      }
    }

    if (candidates.length === 0) {
      let minIdx = 0;
      for (let i = 1; i < hipY.length; i++) {
        if (hipY[i] < hipY[minIdx]) minIdx = i;
      }
      return [minIdx];
    }

    if (expectedCount > 0 && candidates.length > expectedCount) {
      return [...candidates]
        .sort((a, b) => hipY[a] - hipY[b])
        .slice(0, expectedCount)
        .sort((a, b) => a - b);
    }
    return candidates;
  }

  static movingAverage(values, windowSize) {
    if (!values || values.length === 0 || windowSize <= 1) return values;
    const half = Math.floor(windowSize / 2);
    return values.map((_, idx) => {
      const from = Math.max(0, idx - half);
      const to = Math.min(values.length - 1, idx + half);
      let sum = 0;
      for (let i = from; i <= to; i++) sum += values[i];
      return sum / (to - from + 1);
    });
  }

  static estimateWindowFrames(frames, targetMs) {
    if (frames.length < 2) return 5;
    const totalMs = Math.max(1, frames[frames.length - 1].timestampMs - frames[0].timestampMs);
    const avgDt = totalMs / (frames.length - 1);
    return Math.max(2, Math.round(targetMs / Math.max(1, avgDt)));
  }

  static nearestFrame(frames, targetMs) {
    let best = frames[0];
    let bestDiff = Math.abs(best.timestampMs - targetMs);
    for (let i = 1; i < frames.length; i++) {
      const diff = Math.abs(frames[i].timestampMs - targetMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = frames[i];
      }
    }
    return best;
  }

  static toTimingBias(frame) {
    return new TimingBias(frame.timestampMs, frame.leftBiasPercent, frame.rightBiasPercent);
  }

  static averageX(...pts) {
    const valid = pts.filter(p => p != null);
    if (valid.length === 0) return null;
    return valid.reduce((sum, p) => sum + p.x, 0) / valid.length;
  }

  static averageY(...pts) {
    const valid = pts.filter(p => p != null);
    if (valid.length === 0) return null;
    return valid.reduce((sum, p) => sum + p.y, 0) / valid.length;
  }
}
