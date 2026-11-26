/**
 * Centre-of-mass power and lower-limb joint moments / powers for sit-to-stand (estimates from video).
 *
 * Everything is in the analysis body frame (initial seated pelvis orientation, StsMetricCalculator.computeBodyFrame),
 * relative to the mid-ankle, in metres: fwd = forward, up = vertical, left = to the subject's left. The frames are
 * the analysis frames, already smoothed with the smoothing setting; derivatives get a further 5-point moving average.
 *
 * CoM power
 *   F = m (a_CoM + g)  (the resultant external force: feet + seat)
 *   P_CoM = F . v_CoM   (= rate of change of the CoM's kinetic + potential energy), valid before and after seat-off.
 *
 * Joint moments (sagittal plane: fwd, up), bottom-up Newton-Euler inverse dynamics per leg (foot, shank, thigh):
 *   - Ground reaction force on each foot: F (above) x that foot's load share, applied at that foot's COP
 *     (StsMetricCalculator.attachCenterOfPressure). Valid only once the feet carry the whole body (from seat-off).
 *   - Segment mass, centre of mass and radius of gyration: de Leva (1996) proportions of body mass and segment length.
 *   - Reported as internal moments, extension positive: ankle plantarflexion, knee extension, hip extension [N m/kg].
 *   - Joint power = moment on the distal segment x (distal - proximal segment angular velocity) [W/kg];
 *     positive = concentric (energy generation). The hip uses the trunk (mid-hip -> mid-shoulder) as proximal segment.
 */

const G = 9.80665;
// de Leva (1996): mass fraction, CoM from the proximal end (fraction of length), sagittal radius of gyration (fraction)
const SEG = {
  thigh: { mass: 0.1416, com: 0.4095, rg: 0.329 },
  shank: { mass: 0.0433, com: 0.4459, rg: 0.255 },
  foot: { mass: 0.0137, com: 0.4415, rg: 0.257 }   // foot: from the heel towards the toe
};
// Anatomical side -> MediaPipe indices: hip, knee, ankle, heel, toe
const IDX = { left: [23, 25, 27, 29, 31], right: [24, 26, 28, 30, 32] };

const movAvg = (v, w = 5) => {
  const h = w >> 1;
  return v.map((_, i) => {
    let s = 0, n = 0;
    for (let k = i - h; k <= i + h; k++) if (k >= 0 && k < v.length && Number.isFinite(v[k])) { s += v[k]; n++; }
    return n ? s / n : NaN;
  });
};
/** Central-difference derivative of v over t (s), then smoothed. */
const deriv = (v, t) => movAvg(v.map((_, i) => {
  const a = Math.max(0, i - 1), b = Math.min(v.length - 1, i + 1);
  const dt = t[b] - t[a];
  return dt > 0 ? (v[b] - v[a]) / dt : NaN;
}));
const unwrap = (a) => {
  const out = a.slice();
  for (let i = 1; i < out.length; i++) {
    if (!Number.isFinite(out[i]) || !Number.isFinite(out[i - 1])) continue;
    let d = out[i] - out[i - 1];
    while (d > Math.PI) { out[i] -= 2 * Math.PI; d -= 2 * Math.PI; }
    while (d < -Math.PI) { out[i] += 2 * Math.PI; d += 2 * Math.PI; }
  }
  return out;
};
const median = (v) => {
  const a = v.filter(Number.isFinite).sort((p, q) => p - q);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const cross = (r, f) => r[0] * f[1] - r[1] * f[0];   // 2D (fwd, up); positive = rotation from fwd towards up

/**
 * @param result  StsAnalysisResult (frames with comZ/comUp/comLateral/copFeet, bodyFrame, feet, anthropometrics)
 * @returns null without the body frame / 3D landmarks, else
 *   { massKg, series: [{timestampMs, comPowerW, comVel: [fwd, up, left], force: [fwd, up, left],
 *                       joints: {left: {ankle: {moment, power}, knee, hip}, right}}], segmentLengths }
 *   moments in N m/kg, powers in W/kg (joints) and W (CoM).
 */
export function computeKinetics(result) {
  const bf = result?.bodyFrame;
  const frames = result?.frames || [];
  if (!bf || frames.length < 5 || !frames.some(f => f.comUp != null)) return null;
  const m = Math.max(20, Math.min(250, result.anthropometrics?.weightKg || 65));
  const mirrored = !!result.isFrontCameraMirrored;
  const t = frames.map(f => f.timestampMs / 1000);

  // --- CoM power ---
  const comF = frames.map(f => f.comZ ?? NaN), comU = frames.map(f => f.comUp ?? NaN), comL = frames.map(f => f.comLateral ?? NaN);
  const vF = deriv(comF, t), vU = deriv(comU, t), vL = deriv(comL, t);
  const aF = deriv(vF, t), aU = deriv(vU, t), aL = deriv(vL, t);
  const force = frames.map((_, i) => [m * aF[i], m * (aU[i] + G), m * aL[i]]);
  const comPowerW = force.map((F, i) => F[0] * vF[i] + F[1] * vU[i] + F[2] * vL[i]);

  // --- Joint points in the body frame (fwd, up), relative to the mid-ankle ---
  const toBody = (p, a) => {
    const x = p.x - a.x, y = p.y - a.y, z = p.z - a.z;
    return [x * bf.forward.x + z * bf.forward.z, -y];
  };
  const sideIdx = (side) => (mirrored ? IDX[side === "left" ? "right" : "left"] : IDX[side]);
  const pts = (side) => {
    const idx = sideIdx(side);
    return frames.map((f) => {
      const w = f.worldLandmarks || {};
      if (!w[27] || !w[28] || idx.some(i => !w[i])) return null;
      const a = { x: (w[27].x + w[28].x) / 2, y: (w[27].y + w[28].y) / 2, z: (w[27].z + w[28].z) / 2 };
      const [hip, knee, ankle, heel, toe] = idx.map(i => toBody(w[i], a));
      return { hip, knee, ankle, heel, toe };
    });
  };
  // Trunk (mid-hip -> mid-shoulder) angle, the proximal segment of the hip
  const trunkAng = unwrap(frames.map((f) => {
    const w = f.worldLandmarks || {};
    if (!(w[11] && w[12] && w[23] && w[24])) return NaN;
    const sx = (w[11].x + w[12].x - w[23].x - w[24].x) / 2, sy = (w[11].y + w[12].y - w[23].y - w[24].y) / 2, sz = (w[11].z + w[12].z - w[23].z - w[24].z) / 2;
    return Math.atan2(-sy, sx * bf.forward.x + sz * bf.forward.z);
  }));
  const wTrunk = deriv(trunkAng, t);
  const floorUp = result.feet?.floorUp ?? NaN;

  const lengths = {};
  const legs = {};
  for (const side of ["left", "right"]) {
    const P = pts(side);
    const col = (k, c) => P.map(p => (p ? p[k][c] : NaN));
    const seg = (prox, dist) => {
      const ang = unwrap(P.map(p => (p ? Math.atan2(p[dist][1] - p[prox][1], p[dist][0] - p[prox][0]) : NaN)));
      const len = median(P.map(p => (p ? Math.hypot(p[dist][0] - p[prox][0], p[dist][1] - p[prox][1]) : NaN)));
      const w = deriv(ang, t), alpha = deriv(w, t);
      return { ang, len, w, alpha };
    };
    const thigh = seg("hip", "knee"), shank = seg("knee", "ankle"), foot = seg("heel", "toe");
    lengths[side] = { thigh: thigh.len, shank: shank.len, foot: foot.len };
    // Segment CoM positions and accelerations
    const comOf = (prox, dist, frac) => [0, 1].map(c => {
      const pos = P.map(p => (p ? p[prox][c] + frac * (p[dist][c] - p[prox][c]) : NaN));
      return deriv(deriv(pos, t), t);
    });
    const segDyn = {
      thigh: { ...thigh, acc: comOf("hip", "knee", SEG.thigh.com), m: SEG.thigh.mass * m },
      shank: { ...shank, acc: comOf("knee", "ankle", SEG.shank.com), m: SEG.shank.mass * m },
      foot: { ...foot, acc: comOf("heel", "toe", SEG.foot.com), m: SEG.foot.mass * m }
    };
    for (const k of Object.keys(segDyn)) segDyn[k].I = segDyn[k].m * Math.pow(SEG[k].rg * segDyn[k].len, 2);

    legs[side] = frames.map((f, i) => {
      const p = P[i];
      const cf = f.copFeet;
      if (!p || !cf || !Number.isFinite(floorUp)) return null;
      const share = side === "left" ? cf.leftShare : 1 - cf.leftShare;
      const Fg = [force[i][0] * share, force[i][1] * share];
      const cop = [cf[side].fwd, floorUp];
      const lerp = (a, b, s) => [a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])];
      const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
      const neg = (a) => [-a[0], -a[1]];
      const inertial = (s) => [s.m * s.acc[0][i], s.m * (s.acc[1][i] + G)];   // m (a - g)

      // Foot: ankle force/moment on the foot from the shank
      const sf = segDyn.foot, Cf = lerp(p.heel, p.toe, SEG.foot.com);
      const Fa = sub(inertial(sf), Fg);
      const Ma = sf.I * sf.alpha[i] - cross(sub(p.ankle, Cf), Fa) - cross(sub(cop, Cf), Fg);
      // Shank: knee force/moment on the shank from the thigh (the foot pushes back with -Fa, -Ma)
      const ss = segDyn.shank, Cs = lerp(p.knee, p.ankle, SEG.shank.com);
      const Fk = [inertial(ss)[0] + Fa[0], inertial(ss)[1] + Fa[1]];
      const Mk = ss.I * ss.alpha[i] - cross(sub(p.knee, Cs), Fk) - cross(sub(p.ankle, Cs), neg(Fa)) + Ma;
      // Thigh: hip force/moment on the thigh from the pelvis
      const st = segDyn.thigh, Ct = lerp(p.hip, p.knee, SEG.thigh.com);
      const Fh = [inertial(st)[0] + Fk[0], inertial(st)[1] + Fk[1]];
      const Mh = st.I * st.alpha[i] - cross(sub(p.hip, Ct), Fh) - cross(sub(p.knee, Ct), neg(Fk)) + Mk;

      // Moment on the distal segment x relative angular velocity = joint power (sign-convention free)
      const Pa = Ma * (sf.w[i] - ss.w[i]);
      const Pk = Mk * (ss.w[i] - st.w[i]);
      const Ph = Mh * (st.w[i] - wTrunk[i]);
      // Extension-positive internal moments. Rotation from fwd towards up is positive here; the plantarflexors
      // turn the foot toe-down (negative), the knee extensors swing the shank forward (positive), the hip extensors
      // swing the thigh back/down (negative).
      return {
        ankle: { moment: -Ma / m, power: Pa / m },
        knee: { moment: Mk / m, power: Pk / m },
        hip: { moment: -Mh / m, power: Ph / m }
      };
    });
  }

  const series = frames.map((f, i) => ({
    timestampMs: f.timestampMs,
    comPowerW: comPowerW[i],
    comVel: [vF[i], vU[i], vL[i]],
    force: force[i],
    joints: { left: legs.left[i], right: legs.right[i] }
  }));
  return { massKg: m, series, segmentLengths: lengths };
}

/**
 * Per-trial summary (from the trial's current, possibly edited, event times).
 * CoM power: start -> stable (the seat force is included in F, so it is valid before seat-off).
 * Joints: seat-off -> stable (the feet carry the whole body).
 */
export function summarizeKinetics(kin, trial) {
  if (!kin || !trial) return null;
  const end = trial.stableTimeMs ?? trial.standEndTimeMs;
  const all = kin.series.filter(s => s.timestampMs >= trial.startTimeMs && s.timestampMs <= end && Number.isFinite(s.comPowerW));
  let peak = null;
  for (const s of all) if (!peak || s.comPowerW > peak.comPowerW) peak = s;
  const span = kin.series.filter(s => s.timestampMs >= trial.seatOffTimeMs && s.timestampMs <= end);
  const joints = {};
  for (const side of ["left", "right"]) {
    joints[side] = {};
    for (const j of ["hip", "knee", "ankle"]) {
      const v = span.map(s => s.joints[side]?.[j]).filter(Boolean);
      const mom = v.map(x => x.moment).filter(Number.isFinite), pow = v.map(x => x.power).filter(Number.isFinite);
      joints[side][j] = {
        peakMoment: mom.length ? Math.max(...mom) : NaN,
        peakPower: pow.length ? Math.max(...pow) : NaN,
        minPower: pow.length ? Math.min(...pow) : NaN
      };
    }
  }
  return {
    repIndex: trial.repIndex,
    peakComPowerW: peak ? peak.comPowerW : NaN,
    peakComPowerWkg: peak ? peak.comPowerW / kin.massKg : NaN,
    peakComPowerTimeMs: peak ? peak.timestampMs : NaN,
    joints
  };
}
