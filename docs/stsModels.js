/**
 * STS (Sit-to-Stand) Data Models
 */

export const StsMode = {
  SINGLE: {
    id: "SINGLE",
    title: "通常立ち上がり",
    chipLabel: "通常立ち上がり",
    targetReps: 1,
    description: "1回の立ち上がり動作を詳細に分析"
  },
  FIVE_TIMES: {
    id: "FIVE_TIMES",
    title: "5回立ち座り (5STS)",
    chipLabel: "5回 (5STS)",
    targetReps: 5,
    description: "全5回の所要時間と各回バイオメカニクスを評価"
  },
  THIRTY_SECONDS: {
    id: "THIRTY_SECONDS",
    title: "30秒立ち座り (30s-STS)",
    chipLabel: "30秒 (30s-STS)",
    targetReps: 0,
    description: "30秒間の立ち上がり総数・筋持久力を評価"
  }
};

export class SubjectAnthropometrics {
  constructor(heightCm = 170.0, weightKg = 65.0) {
    this.heightCm = heightCm;
    this.weightKg = weightKg;
  }
}

export class Point2D {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}

export class TimingBias {
  constructor(timestampMs, leftPercent, rightPercent) {
    this.timestampMs = timestampMs;
    this.leftPercent = leftPercent;
    this.rightPercent = rightPercent;
  }
}

export class GrfSample {
  constructor(verticalPercentBw = 100.0, verticalNewton = 0.0, lateralPercentBw = 0.0, lateralNewton = 0.0) {
    this.verticalPercentBw = verticalPercentBw;
    this.verticalNewton = verticalNewton;
    this.lateralPercentBw = lateralPercentBw;
    this.lateralNewton = lateralNewton;
  }
}

export class PoseFrameData {
  constructor({
    timestampMs,
    landmarks = {},
    comX = 0.5,
    comY = 0.5,
    midBaseX = 0.5,
    baseWidth = 0.2,
    leftBiasPercent = 50.0,
    rightBiasPercent = 50.0,
    grf = null
  }) {
    this.timestampMs = timestampMs;
    this.landmarks = landmarks; // Map of index -> Point2D
    this.comX = comX;
    this.comY = comY;
    this.midBaseX = midBaseX;
    this.baseWidth = baseWidth;
    this.leftBiasPercent = leftBiasPercent;
    this.rightBiasPercent = rightBiasPercent;
    this.grf = grf;
  }
}

export class FailedAttempt {
  constructor(timestampMs, note = "離臀失敗") {
    this.timestampMs = timestampMs;
    this.note = note;
  }
}

export class SingleTrialMetrics {
  constructor({
    repIndex,
    startTimeMs,
    seatOffTimeMs,
    standEndTimeMs,
    stableTimeMs,
    totalDurationSec,
    seatOffDurationSec,
    risingDurationSec,
    stabilizationDurationSec,
    biasAtStart,
    biasAtSeatOff,
    biasAtStandEnd,
    biasAtStable,
    meanLeftBiasPercent,
    peakVerticalBwPercent,
    peakVerticalNewton,
    minVerticalBwPercent,
    minVerticalNewton,
    peakLateralLeftBwPercent,
    peakLateralLeftNewton,
    peakLateralRightBwPercent,
    peakLateralRightNewton
  }) {
    this.repIndex = repIndex;
    this.startTimeMs = startTimeMs;
    this.seatOffTimeMs = seatOffTimeMs;
    this.standEndTimeMs = standEndTimeMs;
    this.stableTimeMs = stableTimeMs;
    this.totalDurationSec = totalDurationSec;
    this.seatOffDurationSec = seatOffDurationSec;
    this.risingDurationSec = risingDurationSec;
    this.stabilizationDurationSec = stabilizationDurationSec;
    this.biasAtStart = biasAtStart;
    this.biasAtSeatOff = biasAtSeatOff;
    this.biasAtStandEnd = biasAtStandEnd;
    this.biasAtStable = biasAtStable;
    this.meanLeftBiasPercent = meanLeftBiasPercent;
    this.peakVerticalBwPercent = peakVerticalBwPercent;
    this.peakVerticalNewton = peakVerticalNewton;
    this.minVerticalBwPercent = minVerticalBwPercent;
    this.minVerticalNewton = minVerticalNewton;
    this.peakLateralLeftBwPercent = peakLateralLeftBwPercent;
    this.peakLateralLeftNewton = peakLateralLeftNewton;
    this.peakLateralRightBwPercent = peakLateralRightBwPercent;
    this.peakLateralRightNewton = peakLateralRightNewton;
  }
}

export class StsAnalysisResult {
  constructor({
    mode,
    anthropometrics,
    trials = [],
    overallTotalDurationSec = null,
    frames = [],
    isFrontCameraMirrored = false,
    failedAttempts = []
  }) {
    this.mode = mode;
    this.anthropometrics = anthropometrics;
    this.trials = trials;
    this.overallTotalDurationSec = overallTotalDurationSec;
    this.frames = frames;
    this.isFrontCameraMirrored = isFrontCameraMirrored;
    this.failedAttempts = failedAttempts;
  }

  get thirtySecCompletedCount() {
    if (this.mode.id !== "THIRTY_SECONDS" || this.trials.length === 0) return this.trials.length;
    const t0 = this.trials[0].startTimeMs;
    return this.trials.filter(t => t.standEndTimeMs <= t0 + 30000).length;
  }
}
