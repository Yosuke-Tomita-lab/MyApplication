/**
 * STS CSV Exporter Engine
 * Faithful port from StsCsvExporter.kt
 */

import { summarizeKinetics } from "./stsKinetics.js?v=20261126_12";

const KIN_JOINTS = ["hip", "knee", "ankle"];
const KIN_SIDES = [["left", "L"], ["right", "R"]];

export class StsCsvExporter {

  static buildExportCsv(result, selectedTrial = null) {
    const is30s = result.mode.id === "THIRTY_SECONDS";
    const trials = result.trials;
    const fails = result.failedAttempts;

    const totalTrials = trials.length + fails.length;
    const successCount = trials.length;
    const failCount = fails.length;
    const successRate = totalTrials > 0 ? (successCount / totalTrials) * 100.0 : 0.0;
    const failRate = totalTrials > 0 ? (failCount / totalTrials) * 100.0 : 0.0;

    const sb = [];

    // メタデータ
    sb.push("# STS Biomechanical Analysis Report");
    sb.push(`ExportDate,${new Date().toISOString()}`);
    sb.push(`Mode,${result.mode.title}`);
    sb.push(`SubjectHeight_cm,${result.anthropometrics.heightCm.toFixed(1)}`);
    sb.push(`SubjectWeight_kg,${result.anthropometrics.weightKg.toFixed(1)}`);
    sb.push(`FrontCameraMirrored,${result.isFrontCameraMirrored}`);
    const bf = result.bodyFrame;
    if (bf) {
      sb.push(`BodyFrame,${bf.method === "pelvis" ? "initial seated pelvis orientation" : "initial foot orientation"}`);
      sb.push(`BodyFrame_CameraYaw_deg,${bf.cameraYawDeg.toFixed(1)}`);
      if (bf.pelvisFeetAngleDeg != null) sb.push(`BodyFrame_PelvisVsFeet_deg,${bf.pelvisFeetAngleDeg.toFixed(1)}`);
      sb.push("Axes,LM3D X = subject's left / Y = up / Z = forward (m; origin mid-hip). CoM_Z_m = CoM forward of the mid-ankle (m); MidAnkle_Z_m = 0. Lateral GRF positive to the left; AP propulsion = forward.");
    }

    if (result.overallTotalDurationSec != null) {
      sb.push(`OverallTotalDuration_s,${result.overallTotalDurationSec.toFixed(3)}`);
    }
    if (is30s) {
      sb.push(`ThirtySecCompletedCount,${result.thirtySecCompletedCount}`);
    }

    sb.push(`TotalAttemptCount,${totalTrials}`);
    sb.push(`SuccessCount,${successCount}`);
    sb.push(`FailedCount,${failCount}`);
    sb.push(`SuccessRate_percent,${successRate.toFixed(1)}`);
    sb.push(`FailedRate_percent,${failRate.toFixed(1)}`);

    if (fails.length > 0) {
      const failTimestamps = fails.map(f => (f.timestampMs / 1000.0).toFixed(2) + "s").join("; ");
      sb.push(`FailedTimestamps,${failTimestamps}`);
    }

    sb.push("");
    sb.push("# Trial Summaries");

    // ヘッダー行
    const summaryHeaders = [
      "Rep",
      "StartTime_s",
      "SeatOffTime_s",
      "StandEndTime_s",
      ...(is30s ? [] : ["StableTime_s"]),
      "TotalDuration_s",
      "CumulativeTime_s",
      "SeatOffDuration_s",
      "RisingDuration_s",
      ...(is30s ? [] : ["StabilizationDuration_s"]),
      "Start_LeftBias_pct",
      "SeatOff_LeftBias_pct",
      "StandEnd_LeftBias_pct",
      ...(is30s ? [] : ["Stable_LeftBias_pct"]),
      "Mean_LeftBias_pct",
      "PeakVertical_pctBW",
      "PeakVertical_N",
      "MinVertical_pctBW",
      "MinVertical_N",
      "PeakLateralLeft_pctBW",
      "PeakLateralLeft_N",
      "PeakLateralRight_pctBW",
      "PeakLateralRight_N",
      // 3D・矢状面指標
      "SeatOff_CoM_Ankle_AP_Dist_cm",
      "Peak_Forward_Pitch_Vel_deg_per_s",
      "Peak_AP_Propulsion_pctBW",
      "Peak_AP_Propulsion_N",
      "Peak_AP_Braking_pctBW",
      "Peak_AP_Braking_N",
      "Max_Trunk_Flexion_deg",
      "Max_Hip_Flexion_deg",
      "Knee_ROM_deg",
      "Total_AP_CoM_Excursion_cm"
    ];
    sb.push(summaryHeaders.join(","));

    // 各試行データ行
    const t0 = trials.length > 0 ? trials[0].startTimeMs : 0;
    for (const t of trials) {
      const cumTime = ((t.standEndTimeMs - t0) / 1000.0).toFixed(3);
      const row = [
        t.repIndex,
        (t.startTimeMs / 1000.0).toFixed(3),
        (t.seatOffTimeMs / 1000.0).toFixed(3),
        (t.standEndTimeMs / 1000.0).toFixed(3),
        ...(is30s ? [] : [(t.stableTimeMs / 1000.0).toFixed(3)]),
        t.totalDurationSec.toFixed(3),
        cumTime,
        t.seatOffDurationSec.toFixed(3),
        t.risingDurationSec.toFixed(3),
        ...(is30s ? [] : [t.stabilizationDurationSec.toFixed(3)]),
        t.biasAtStart.leftPercent.toFixed(1),
        t.biasAtSeatOff.leftPercent.toFixed(1),
        t.biasAtStandEnd.leftPercent.toFixed(1),
        ...(is30s ? [] : [t.biasAtStable.leftPercent.toFixed(1)]),
        t.meanLeftBiasPercent.toFixed(1),
        t.peakVerticalBwPercent.toFixed(1),
        t.peakVerticalNewton.toFixed(1),
        t.minVerticalBwPercent.toFixed(1),
        t.minVerticalNewton.toFixed(1),
        t.peakLateralLeftBwPercent.toFixed(1),
        t.peakLateralLeftNewton.toFixed(1),
        t.peakLateralRightBwPercent.toFixed(1),
        t.peakLateralRightNewton.toFixed(1),
        // 3D・矢状面
        (t.comAnkleApDistanceAtSeatOffCm ?? 0).toFixed(1),
        (t.peakForwardPitchVelocityDegPerSec ?? 0).toFixed(1),
        (t.peakApGrfPropulsionPercentBw ?? 0).toFixed(1),
        (t.peakApGrfPropulsionNewton ?? 0).toFixed(1),
        (t.peakApGrfBrakingPercentBw ?? 0).toFixed(1),
        (t.peakApGrfBrakingNewton ?? 0).toFixed(1),
        (t.maxTrunkFlexionDeg ?? 0).toFixed(1),
        (t.maxHipFlexionDeg ?? 0).toFixed(1),
        (t.kneeRomDeg ?? 0).toFixed(1),
        (t.totalApComExcursionCm ?? 0).toFixed(1)
      ];
      sb.push(row.join(","));
    }

    // 平均値行
    if (trials.length > 1) {
      const avg = fn => (trials.reduce((sum, t) => sum + (fn(t) || 0), 0) / trials.length).toFixed(3);
      const avgRow = [
        "Average",
        "-", "-", "-",
        ...(is30s ? [] : ["-"]),
        avg(t => t.totalDurationSec),
        "-",
        avg(t => t.seatOffDurationSec),
        avg(t => t.risingDurationSec),
        ...(is30s ? [] : [avg(t => t.stabilizationDurationSec)]),
        avg(t => t.biasAtStart.leftPercent),
        avg(t => t.biasAtSeatOff.leftPercent),
        avg(t => t.biasAtStandEnd.leftPercent),
        ...(is30s ? [] : [avg(t => t.biasAtStable.leftPercent)]),
        avg(t => t.meanLeftBiasPercent),
        avg(t => t.peakVerticalBwPercent),
        avg(t => t.peakVerticalNewton),
        avg(t => t.minVerticalBwPercent),
        avg(t => t.minVerticalNewton),
        avg(t => t.peakLateralLeftBwPercent),
        avg(t => t.peakLateralLeftNewton),
        avg(t => t.peakLateralRightBwPercent),
        avg(t => t.peakLateralRightNewton),
        avg(t => t.comAnkleApDistanceAtSeatOffCm),
        avg(t => t.peakForwardPitchVelocityDegPerSec),
        avg(t => t.peakApGrfPropulsionPercentBw),
        avg(t => t.peakApGrfPropulsionNewton),
        avg(t => t.peakApGrfBrakingPercentBw),
        avg(t => t.peakApGrfBrakingNewton),
        avg(t => t.maxTrunkFlexionDeg),
        avg(t => t.maxHipFlexionDeg),
        avg(t => t.kneeRomDeg),
        avg(t => t.totalApComExcursionCm)
      ];
      sb.push(avgRow.join(","));
    }

    // 重心パワー・関節モーメント/パワー（推定）
    const kin = result.kinetics || null;
    if (kin) {
      sb.push("");
      sb.push("# Power & Joint Kinetics (estimated from video: CoM-based GRF, COP and left/right split; de Leva segment parameters)");
      sb.push("# CoM power = m(a+g).v from start to stable; joint peaks from seat-off to stable. Moments: internal, extension (ankle plantarflexion) positive, N m/kg. Powers: W/kg, positive = generation.");
      const head = ["Rep", "PeakCoMPower_W", "PeakCoMPower_W_per_kg", "PeakCoMPowerTime_s"];
      for (const [, S] of KIN_SIDES) for (const j of KIN_JOINTS) head.push(`${S}_${j}_PeakMoment_Nm_per_kg`, `${S}_${j}_PeakPower_W_per_kg`, `${S}_${j}_MinPower_W_per_kg`);
      sb.push(head.join(","));
      const f2 = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "");
      for (const t of trials) {
        const k = summarizeKinetics(kin, t);
        if (!k) continue;
        const row = [t.repIndex, f2(k.peakComPowerW, 1), f2(k.peakComPowerWkg), f2(k.peakComPowerTimeMs / 1000, 3)];
        for (const [side] of KIN_SIDES) for (const j of KIN_JOINTS) {
          const v = k.joints[side][j];
          row.push(f2(v.peakMoment), f2(v.peakPower), f2(v.minPower));
        }
        sb.push(row.join(","));
      }
    }

    sb.push("");
    sb.push("# Frame Time Series");
    const frameHeaders = [
      "Timestamp_ms",
      "Time_s",
      "ActiveRep",
      "PhaseName",
      "CoM_X",
      "CoM_Y",
      "CoM_Z_m",
      "MidBase_X",
      "MidAnkle_Z_m",
      "BaseWidth",
      "LeftBias_pct",
      "RightBias_pct",
      "TrunkAngle_deg",
      "HipAngle_deg",
      "KneeAngle_deg",
      "Vertical_pctBW",
      "Vertical_N",
      "Lateral_pctBW",
      "Lateral_N",
      "AP_Propulsion_pctBW",
      "AP_Propulsion_N",
      "AP_Braking_pctBW",
      "AP_Braking_N",
      "COP_Forward_m",
      "COP_Left_m",
      "COP_LeftFootShare_pct",
      "CoM_Power_W"
    ];
    for (const [, S] of KIN_SIDES) for (const j of KIN_JOINTS) frameHeaders.push(`${S}_${j}_Moment_Nm_per_kg`, `${S}_${j}_Power_W_per_kg`);
    for (let i = 0; i < 33; i++) {
      frameHeaders.push(`LM${i}_X`, `LM${i}_Y`, `LM3D_${i}_X`, `LM3D_${i}_Y`, `LM3D_${i}_Z`);
    }
    sb.push(frameHeaders.join(","));

    for (const [fi, f] of result.frames.entries()) {
      const activePhase = this.resolveActivePhase(f.timestampMs, trials, fails, is30s);
      const row = [
        f.timestampMs,
        (f.timestampMs / 1000.0).toFixed(3),
        activePhase.rep,
        activePhase.phase,
        f.comX.toFixed(4),
        f.comY.toFixed(4),
        (f.comZ ?? 0).toFixed(4),
        f.midBaseX.toFixed(4),
        (f.midAnkleZ ?? 0).toFixed(4),
        f.baseWidth.toFixed(4),
        f.leftBiasPercent.toFixed(1),
        f.rightBiasPercent.toFixed(1),
        (f.trunkAngleDeg ?? 0).toFixed(1),
        (f.hipAngleDeg ?? 0).toFixed(1),
        (f.kneeAngleDeg ?? 0).toFixed(1),
        f.grf ? f.grf.verticalPercentBw.toFixed(1) : "100.0",
        f.grf ? f.grf.verticalNewton.toFixed(1) : "0.0",
        f.grf ? f.grf.lateralPercentBw.toFixed(1) : "0.0",
        f.grf ? f.grf.lateralNewton.toFixed(1) : "0.0",
        f.grf ? f.grf.apPropulsionPercentBw.toFixed(1) : "0.0",
        f.grf ? f.grf.apPropulsionNewton.toFixed(1) : "0.0",
        f.grf ? f.grf.apBrakingPercentBw.toFixed(1) : "0.0",
        f.grf ? f.grf.apBrakingNewton.toFixed(1) : "0.0",
        f.cop ? f.cop.fwd.toFixed(4) : "",
        f.cop ? f.cop.left.toFixed(4) : "",
        f.copFeet ? (f.copFeet.leftShare * 100).toFixed(1) : "",
        kin && Number.isFinite(kin.series[fi]?.comPowerW) ? kin.series[fi].comPowerW.toFixed(1) : ""
      ];
      for (const [side] of KIN_SIDES) for (const j of KIN_JOINTS) {
        const v = kin?.series[fi]?.joints[side]?.[j];
        row.push(v && Number.isFinite(v.moment) ? v.moment.toFixed(3) : "", v && Number.isFinite(v.power) ? v.power.toFixed(3) : "");
      }
      for (let i = 0; i < 33; i++) {
        const pt = f.landmarks[i];
        const w0 = f.worldLandmarks ? f.worldLandmarks[i] : null;
        // 3D landmarks in the body frame (left, up, forward) when available
        const wpt = (w0 && bf) ? {
          x: w0.x * bf.left.x + w0.z * bf.left.z,
          y: -w0.y,
          z: w0.x * bf.forward.x + w0.z * bf.forward.z
        } : w0;
        row.push(
          pt ? pt.x.toFixed(4) : "",
          pt ? pt.y.toFixed(4) : "",
          wpt ? wpt.x.toFixed(4) : "",
          wpt ? wpt.y.toFixed(4) : "",
          wpt ? wpt.z.toFixed(4) : ""
        );
      }
      sb.push(row.join(","));
    }

    return sb.join("\r\n");
  }

  static resolveActivePhase(timestampMs, trials, fails, is30s) {
    const isFail = fails.some(fail => Math.abs(fail.timestampMs - timestampMs) <= 250);
    const failSuffix = isFail ? "[離臀失敗]" : "";

    if (trials.length === 0) return { rep: "なし", phase: "待機" + failSuffix };

    for (const t of trials) {
      const endLimit = is30s ? t.standEndTimeMs : t.stableTimeMs;
      if (timestampMs >= t.startTimeMs && timestampMs <= endLimit) {
        let phase = "";
        if (timestampMs < t.seatOffTimeMs) {
          phase = "開始〜離臀前";
        } else if (timestampMs < t.standEndTimeMs) {
          phase = "立ち上がり中";
        } else if (!is30s && timestampMs < t.stableTimeMs) {
          phase = "立位安定化中";
        } else {
          phase = is30s ? "立ち上がり終了" : "立位安定";
        }
        return { rep: `Rep_${t.repIndex}`, phase: phase + failSuffix };
      }
    }
    return { rep: "なし", phase: "インターバル・待機" + failSuffix };
  }

  static downloadCsv(result, filename = null) {
    const csvContent = this.buildExportCsv(result);
    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.setAttribute("href", url);
    const defaultName = filename || `STS_${result.mode.id}_Analysis_${new Date().toISOString().replace(/[:.]/g, "")}.csv`;
    link.setAttribute("download", defaultName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}
