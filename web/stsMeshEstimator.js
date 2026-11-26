/**
 * STS Mesh Estimator: InstantHMR (MHR body mesh) running entirely in the browser.
 *
 * One person per frame. The first frame starts from the whole image and refines the person box on the
 * model's own keypoints; every later frame takes its box from the previous frame's keypoints (the same
 * tracking InstantHMR's own pipeline uses between detector runs), so no separate person detector is needed.
 *
 * Output per frame, in the shapes the rest of the analyzer already uses:
 *   landmarks      MediaPipe Pose index -> {x, y} normalised to the image (0..1)
 *   worldLandmarks MediaPipe Pose index -> {x, y, z, visibility}, metres, hip-centred, y down (MediaPipe convention)
 *   vertices       Float32Array(18439 * 3), metres, body-local frame (same frame as joints3d)
 *   joints3d       Float32Array(70 * 3), metres, body-local frame
 *   meshCom        whole-body centre of mass of the mesh volume (uniform density):
 *                  {world: {x, y, z} in the worldLandmarks frame, image: {x, y} normalised, volumeM3}
 *
 * Model: InstantHMR medium + kinematic fit on one crop, converted for onnxruntime-web
 * (scripts/convert_instanthmr_web.py). Weights: SAM License, non-commercial use only (see web/licenses/).
 */

const ORT_VERSION = "1.31.1";
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
export const DEFAULT_MODEL_BASE = "https://huggingface.co/yomita/instanthmr-web/resolve/main/";
const MODEL_FILE = "instanthmr-medium-fit1-web.onnx";
const BODY_FILE = "mhr-body.onnx";
const FACES_URL = new URL("./assets/mhr_faces.u16.bin", import.meta.url).href;
const CACHE_NAME = "sts-instanthmr-v1";

// Constants from InstantHMR inference.py / pipeline.py
const SIZE = 288;
const CROP_EXPAND = 1.2;
const FOCAL_FALLBACK_DIAG = 1.05;
const DETECTOR_TO_GT_BOX = 1 / 0.866;
const CROP_SCALE = 0.9;
const BODY_KEYPOINTS = [...Array(21).keys(), 41, 62, 63, 64, 65, 66, 67, 68, 69];

/** MHR70 keypoint index -> MediaPipe Pose (33) index. */
export const MHR_TO_MEDIAPIPE = {
  0: 0,    // nose
  1: 2,    // left eye
  2: 5,    // right eye
  3: 7,    // left ear
  4: 8,    // right ear
  5: 11,   // left shoulder
  6: 12,   // right shoulder
  7: 13,   // left elbow
  8: 14,   // right elbow
  62: 15,  // left wrist
  41: 16,  // right wrist
  9: 23,   // left hip
  10: 24,  // right hip
  11: 25,  // left knee
  12: 26,  // right knee
  13: 27,  // left ankle
  14: 28,  // right ankle
  17: 29,  // left heel
  20: 30,  // right heel
  15: 31,  // left big toe
  18: 32,  // right big toe
};

export class StsMeshEstimator {
  constructor({ modelBaseUrl = DEFAULT_MODEL_BASE, onProgress = () => {} } = {}) {
    this.modelBaseUrl = modelBaseUrl.endsWith("/") ? modelBaseUrl : modelBaseUrl + "/";
    this.onProgress = onProgress;
    this.ort = null;
    this.hmr = null;
    this.body = null;
    this.faces = null;
    this.backend = null;
    this.box = null;
    this.cropCanvas = document.createElement("canvas");
    this.cropCanvas.width = this.cropCanvas.height = SIZE;
    this.cropCtx = this.cropCanvas.getContext("2d", { willReadFrequently: true });
  }

  static isWebGpuAvailable() {
    return typeof navigator !== "undefined" && "gpu" in navigator;
  }

  get ready() {
    return !!(this.hmr && this.body && this.faces);
  }

  /**
   * One onnxruntime-web instance per build: "ort.all.min.mjs" (WebGPU + CPU, JSEP wasm) or "ort.wasm.min.mjs"
   * (CPU only, smaller wasm). Separate instances, so a failed WebGPU start-up does not block the CPU fallback.
   */
  static async loadOrt(bundle) {
    StsMeshEstimator.ortModules = StsMeshEstimator.ortModules || {};
    if (!StsMeshEstimator.ortModules[bundle]) {
      const ort = await import(`${ORT_BASE}${bundle}`);
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      StsMeshEstimator.ortModules[bundle] = ort;
    }
    return StsMeshEstimator.ortModules[bundle];
  }

  /** Downloads (once, then from the browser cache) and prepares the models. Returns the backend used. */
  async init({ preferWebGpu = true } = {}) {
    if (this.ready) return this.backend;
    const progress = { loaded: 0, total: 0 };
    const report = () => this.onProgress({ stage: "download", loaded: progress.loaded, total: progress.total });
    const [hmrBuf, bodyBuf, facesBuf] = await Promise.all([
      this.fetchModel(this.modelBaseUrl + MODEL_FILE, progress, report),
      this.fetchModel(this.modelBaseUrl + BODY_FILE, progress, report),
      fetch(FACES_URL).then((r) => {
        if (!r.ok) throw new Error(`メッシュの面データを取得できません (HTTP ${r.status})`);
        return r.arrayBuffer();
      }),
    ]);
    this.faces = new Uint16Array(facesBuf);
    this.onProgress({ stage: "session" });

    let useGpu = preferWebGpu && StsMeshEstimator.isWebGpuAvailable();
    if (useGpu) {
      // navigator.gpu can exist without a usable adapter; onnxruntime then drops WebGPU silently.
      try { useGpu = !!(await navigator.gpu.requestAdapter()); } catch { useGpu = false; }
    }
    let gpuError = null;
    if (useGpu) {
      try {
        const ort = await StsMeshEstimator.loadOrt("ort.all.min.mjs");
        this.hmr = await ort.InferenceSession.create(hmrBuf, { executionProviders: ["webgpu", "wasm"] });
        this.body = await ort.InferenceSession.create(bodyBuf, { executionProviders: ["wasm"] });
        this.ort = ort;
        this.backend = "webgpu";
      } catch (e) {
        // e.g. iPad/iPhone (WebKit): WebGPU is exposed but onnxruntime's WebGPU runtime fails to start. That failure
        // poisons this onnxruntime instance ("previous call to 'initWasm()' failed"), so the CPU fallback below
        // loads a separate, CPU-only build instead of reusing it.
        gpuError = e;
        console.warn("InstantHMR: WebGPU unavailable, falling back to WASM:", e);
        this.hmr = null; this.body = null;
      }
    }
    if (!this.hmr) {
      try {
        const ort = await StsMeshEstimator.loadOrt("ort.wasm.min.mjs");
        this.hmr = await ort.InferenceSession.create(hmrBuf, { executionProviders: ["wasm"] });
        // The body model is small; it runs on the CPU in every case.
        this.body = await ort.InferenceSession.create(bodyBuf, { executionProviders: ["wasm"] });
        this.ort = ort;
        this.backend = "wasm";
      } catch (e) {
        this.hmr = null; this.body = null;
        const msg = `CPU(WASM)での初期化に失敗しました: ${e?.message || e}` + (gpuError ? ` / WebGPU: ${gpuError?.message || gpuError}` : "");
        throw new Error(msg);
      }
    }
    return this.backend;
  }

  async fetchModel(url, progress, report) {
    let cache = null;
    try { cache = await caches.open(CACHE_NAME); } catch { /* no Cache API (private mode etc.) */ }
    let res = cache ? await cache.match(url) : null;
    if (!res) {
      res = await fetch(url);
      if (!res.ok) throw new Error(`モデルを取得できません: ${url.split("/").pop()} (HTTP ${res.status})`);
      if (cache) {
        try { await cache.put(url, res.clone()); } catch { /* quota: continue without caching */ }
      }
    }
    const total = Number(res.headers.get("content-length")) || 0;
    progress.total += total;
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      progress.loaded += value.length;
      report();
    }
    const out = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  /** Forget the tracked person box (call before a new video). */
  resetTracking() {
    this.box = null;
  }

  /** Estimate the body in `source` (a canvas holding the current video frame). */
  async estimate(source) {
    if (!this.ready) throw new Error("StsMeshEstimator.init() has not finished");
    const W = source.width, H = source.height;
    if (!this.box) {
      // Bootstrap: whole frame, then refine twice on the person's own keypoints.
      let box = [0, 0, W, H];
      for (let i = 0; i < 2; i++) {
        const r = await this.run(source, box, W, H);
        box = keypointBox(r.joints2d, W, H);
      }
      this.box = box;
    }
    const t0 = performance.now();
    const r = await this.run(source, this.box, W, H);
    const ms = performance.now() - t0;
    const next = keypointBox(r.joints2d, W, H);
    // A box collapsing to a sliver means the person was lost: start over on the next frame.
    this.box = (next[2] - next[0] > 8 && next[3] - next[1] > 8) ? next : null;

    const landmarks = {}, worldLandmarks = {};
    const j = r.joints3d;
    const hip = [0, 1, 2].map((a) => (j[9 * 3 + a] + j[10 * 3 + a]) / 2);
    for (const [m, p] of Object.entries(MHR_TO_MEDIAPIPE)) {
      const k = Number(m);
      landmarks[p] = { x: r.joints2d[k * 2] / W, y: r.joints2d[k * 2 + 1] / H };
      worldLandmarks[p] = { x: j[k * 3] - hip[0], y: j[k * 3 + 1] - hip[1], z: j[k * 3 + 2] - hip[2], visibility: 0.99 };
    }
    const c = meshCenterOfMass(r.vertices, this.faces);
    let meshCom = null;
    if (c) {
      const zc = c.com[2] + r.camTrans[2];
      meshCom = {
        world: { x: c.com[0] - hip[0], y: c.com[1] - hip[1], z: c.com[2] - hip[2] },
        image: zc > 0.05 ? { x: (r.focal * (c.com[0] + r.camTrans[0]) / zc + W / 2) / W,
                             y: (r.focal * (c.com[1] + r.camTrans[1]) / zc + H / 2) / H } : null,
        volumeM3: c.volume
      };
    }
    return { landmarks, worldLandmarks, vertices: r.vertices, joints3d: r.joints3d, camTrans: r.camTrans, meshCom,
             mhrParams: r.mhrParams, shapeParams: r.shapeParams, focalPx: r.focal, ms };
  }

  /** InstantHMR._estimate_fit for one person on one crop. */
  async run(source, box, W, H) {
    const ort = this.ort;
    const f = FOCAL_FALLBACK_DIAG * Math.hypot(H, W);
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    const size = Math.max(box[2] - box[0], box[3] - box[1]) * DETECTOR_TO_GT_BOX * CROP_SCALE;
    const side = size * CROP_EXPAND;
    const ix1 = Math.floor(cx - side / 2), iy1 = Math.floor(cy - side / 2);
    const ix2 = Math.ceil(cx - side / 2 + side), iy2 = Math.ceil(cy - side / 2 + side);
    const sx = (ix2 - ix1) / SIZE, sy = (iy2 - iy1) / SIZE;

    const ctx = this.cropCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.imageSmoothingQuality = "high";
    ctx.setTransform(1 / sx, 0, 0, 1 / sy, -ix1 / sx, -iy1 / sy);
    ctx.drawImage(source, 0, 0);
    const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const rgb = new Uint8Array(SIZE * SIZE * 3);
    for (let i = 0, k = 0; i < px.length; i += 4) { rgb[k++] = px[i]; rgb[k++] = px[i + 1]; rgb[k++] = px[i + 2]; }

    const o = await this.hmr.run({
      image: new ort.Tensor("uint8", rgb, [1, SIZE, SIZE, 3]),
      cliff_cond: new ort.Tensor("float32", Float32Array.from([Math.atan((cx - W / 2) / f), Math.atan((cy - H / 2) / f), size / f]), [1, 3]),
      crop_box: new ort.Tensor("float32", Float32Array.from([ix1, iy1, ix2 - ix1, iy2 - iy1]), [1, 4]),
      cam: new ort.Tensor("float32", Float32Array.from([f, W / 2, H / 2]), [1, 3]),
    });
    // Re-wrap with the declared shapes: some WebGPU kernels report a transposed shape for these outputs.
    const mhrParams = Float32Array.from(o.mhr_params.data);
    const shapeParams = Float32Array.from(o.shape_params.data);
    const b = await this.body.run({
      mhr_params: new ort.Tensor("float32", mhrParams, [1, 204]),
      shape_params: new ort.Tensor("float32", shapeParams, [1, 45]),
    });
    return {
      focal: f,
      camTrans: Array.from(o.cam_trans.data),
      joints2d: Float32Array.from(o.joints_2d.data),
      joints3d: Float32Array.from(b.joints_3d.data),
      vertices: Float32Array.from(b.vertices.data),
      mhrParams, shapeParams,
    };
  }
}

/**
 * Centre of mass of the solid the mesh encloses, at uniform density, and its volume (m^3).
 * The MHR mesh is closed and manifold, so the signed tetrahedra from the origin to each face sum to the body.
 * Returns null if the mesh does not enclose a positive volume.
 */
export function meshCenterOfMass(vertices, faces) {
  if (!vertices || !faces) return null;
  let v6 = 0, cx = 0, cy = 0, cz = 0;
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
    const qx = vertices[c], qy = vertices[c + 1], qz = vertices[c + 2];
    const d = ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
    v6 += d;
    cx += d * (ax + bx + qx); cy += d * (ay + by + qy); cz += d * (az + bz + qz);
  }
  if (!(v6 > 1e-9)) return null;
  return { com: [cx / (4 * v6), cy / (4 * v6), cz / (4 * v6)], volume: v6 / 6 };
}

/** pipeline.keypoint_box: the body keypoints' extent, padded, shrunk to a detector's framing, clipped. */
function keypointBox(j2d, W, H, pad = 0.15) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of BODY_KEYPOINTS) {
    const x = j2d[k * 2], y = j2d[k * 2 + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hx = (x1 - x0) * (0.5 + pad) / DETECTOR_TO_GT_BOX, hy = (y1 - y0) * (0.5 + pad) / DETECTOR_TO_GT_BOX;
  return [Math.max(0, cx - hx), Math.max(0, cy - hy), Math.min(W, cx + hx), Math.min(H, cy + hy)];
}
