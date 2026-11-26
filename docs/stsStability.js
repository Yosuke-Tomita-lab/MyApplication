/**
 * Margin of stability (Hof et al., J Biomech 2005) for sit-to-stand, in the anteroposterior (AP) and
 * mediolateral (ML) directions, from the 3D landmarks (and the mesh CoM when the InstantHMR engine is used).
 *
 *   XcoM = CoM + v / omega0,  omega0 = sqrt(g / l),  l = 1.2 x leg length
 *   MoS_AP = distance from XcoM to the nearer of the anterior (toes) and posterior (heels) edges
 *   MoS_ML = distance from XcoM to the nearer of the left and right edges
 *   Both are positive while XcoM is inside the base of support and negative outside it (e.g. XcoM still behind
 *   the heels at seat-off).
 *
 * Everything is in the horizontal plane, relative to the mid-ankle point, which does not move during a
 * sit-to-stand, so positions and velocities there are ground-fixed. The body axes come from the feet:
 * forward = mean heel -> toe direction, left = towards the left foot. The base of support is the bounding box,
 * in those axes, of both feet's ankle, heel and toe points (their median positions over the recording).
 */

const GRAVITY = 9.80665;
const FOOT_POINTS = { left: [27, 29, 31], right: [28, 30, 32] };   // ankle, heel, toe (MediaPipe Pose indices)

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const median = (v) => {
  const a = v.filter(Number.isFinite).sort((p, q) => p - q);
  if (a.length === 0) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const percentile = (v, p) => {
  const a = v.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))] : NaN;
};

/** Whole-body CoM in the worldLandmarks frame: the mesh CoM if present, else the 3-segment estimate. */
function frameCom3D(f) {
  if (f.meshCom && f.meshCom.world) return f.meshCom.world;
  const w = f.worldLandmarks || {};
  if (!(w[11] && w[12] && w[23] && w[24] && w[27] && w[28])) return null;
  const sh = mid(w[11], w[12]), hip = mid(w[23], w[24]), ank = mid(w[27], w[28]);
  return {
    x: 0.35 * sh.x + 0.35 * hip.x + 0.30 * ank.x,
    y: 0.35 * sh.y + 0.35 * hip.y + 0.30 * ank.y,
    z: 0.35 * sh.z + 0.35 * hip.z + 0.30 * ank.z
  };
}

/**
 * @param frames  analysis frames (StsAnalysisResult.frames)
 * @param trials  analysis trials (seatOffTimeMs, standEndTimeMs, stableTimeMs, startTimeMs)
 * @param isMirrored  front-camera mirroring (swaps which landmarks are the anatomical left foot)
 * @returns null when the landmarks are missing, else
 *   { axes, legLengthM, omega0, bos: {anterior, posterior, left, right}, feet: {left: [[f, m]...], right: [...]},
 *     series: [{timestampMs, com: [f, m], xcom: [f, m], mosAp, mosMl}], trials: [{repIndex, ...summary}] }
 *   where [f, m] are metres forward / to the left of the mid-ankle point.
 */
export function computeMarginOfStability(frames, trials, isMirrored = false) {
  if (!frames || frames.length < 5) return null;
  const L = isMirrored ? FOOT_POINTS.right : FOOT_POINTS.left;
  const R = isMirrored ? FOOT_POINTS.left : FOOT_POINTS.right;

  // Per-frame points relative to the mid-ankle, horizontal (x, z)
  const rel = frames.map((f) => {
    const w = f.worldLandmarks || {};
    if (!w[27] || !w[28]) return null;
    const a = mid(w[27], w[28]);
    const pt = (i) => (w[i] ? { x: w[i].x - a.x, z: w[i].z - a.z } : null);
    const c = frameCom3D(f);
    return {
      t: f.timestampMs,
      left: L.map(pt), right: R.map(pt),
      com: c ? { x: c.x - a.x, z: c.z - a.z } : null,
      leg: (w[23] && w[24]) ? (Math.hypot(w[23].x - w[27].x, w[23].y - w[27].y, w[23].z - w[27].z) +
                               Math.hypot(w[24].x - w[28].x, w[24].y - w[28].y, w[24].z - w[28].z)) / 2 : NaN
    };
  });
  const valid = rel.filter((r) => r && r.com);
  if (valid.length < 5) return null;

  // Median foot points over the recording (feet stay put during a sit-to-stand)
  const medPt = (side, k) => {
    const ps = valid.map((r) => r[side][k]).filter(Boolean);
    return ps.length ? { x: median(ps.map((p) => p.x)), z: median(ps.map((p) => p.z)) } : null;
  };
  const feet = { left: [0, 1, 2].map((k) => medPt("left", k)), right: [0, 1, 2].map((k) => medPt("right", k)) };
  if ([...feet.left, ...feet.right].some((p) => !p)) return null;

  // Body axes from the feet: forward = mean heel -> toe; left = perpendicular, pointing to the left foot
  let fx = (feet.left[2].x - feet.left[1].x) + (feet.right[2].x - feet.right[1].x);
  let fz = (feet.left[2].z - feet.left[1].z) + (feet.right[2].z - feet.right[1].z);
  const fn = Math.hypot(fx, fz) || 1;
  fx /= fn; fz /= fn;
  let mx = -fz, mz = fx;
  const lr = { x: feet.left[0].x - feet.right[0].x, z: feet.left[0].z - feet.right[0].z };
  if (mx * lr.x + mz * lr.z < 0) { mx = -mx; mz = -mz; }
  const toBody = (p) => [p.x * fx + p.z * fz, p.x * mx + p.z * mz];

  const feetBody = { left: feet.left.map(toBody), right: feet.right.map(toBody) };
  const all = [...feetBody.left, ...feetBody.right];
  const bos = {
    anterior: Math.max(...all.map((p) => p[0])),
    posterior: Math.min(...all.map((p) => p[0])),
    left: Math.max(...all.map((p) => p[1])),
    right: Math.min(...all.map((p) => p[1]))
  };

  // Inverted-pendulum length: 1.2 x leg length (hip-ankle with the legs nearly straight)
  const legLengthM = percentile(valid.map((r) => r.leg), 0.9);
  const l = 1.2 * (Number.isFinite(legLengthM) && legLengthM > 0.4 ? legLengthM : 0.85);
  const omega0 = Math.sqrt(GRAVITY / l);

  // CoM velocity by central differences (the frames are already smoothed upstream)
  const series = [];
  for (let i = 0; i < valid.length; i++) {
    const p = toBody(valid[i].com);
    const a = valid[Math.max(0, i - 1)], b = valid[Math.min(valid.length - 1, i + 1)];
    const dt = (b.t - a.t) / 1000;
    const pa = toBody(a.com), pb = toBody(b.com);
    const v = dt > 0 ? [(pb[0] - pa[0]) / dt, (pb[1] - pa[1]) / dt] : [0, 0];
    const xcom = [p[0] + v[0] / omega0, p[1] + v[1] / omega0];
    series.push({
      timestampMs: valid[i].t,
      com: p,
      xcom,
      mosAp: Math.min(bos.anterior - xcom[0], xcom[0] - bos.posterior),
      mosMl: Math.min(bos.left - xcom[1], xcom[1] - bos.right)
    });
  }

  const at = (t) => {
    let best = null, d = Infinity;
    for (const s of series) { const e = Math.abs(s.timestampMs - t); if (e < d) { d = e; best = s; } }
    return best;
  };
  const trialSummaries = (trials || []).map((tr) => {
    const seat = at(tr.seatOffTimeMs);
    const end = tr.stableTimeMs ?? tr.standEndTimeMs;
    const span = series.filter((s) => s.timestampMs >= tr.seatOffTimeMs && s.timestampMs <= end);
    const minOf = (k) => (span.length ? Math.min(...span.map((s) => s[k])) : NaN);
    return {
      repIndex: tr.repIndex,
      mosApAtSeatOffCm: seat ? seat.mosAp * 100 : NaN,
      mosMlAtSeatOffCm: seat ? seat.mosMl * 100 : NaN,
      minMosApCm: minOf("mosAp") * 100,
      minMosMlCm: minOf("mosMl") * 100
    };
  });

  return { axes: { forward: [fx, fz], left: [mx, mz] }, legLengthM, omega0, bos, feet: feetBody, series, trials: trialSummaries };
}
