/**
 * STS 3D Biomechanical Mesh & Skeleton Viewer (Three.js)
 * Visualizes 3D volumetric human mesh, Center of Mass (CoM) trajectory,
 * base of support projection, and chair in sagittal/frontal/3D views.
 */

export class Sts3dViewer {
  constructor(containerElement) {
    this.container = containerElement;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.animationFrameId = null;

    // 3D Objects
    this.jointMeshes = {};
    this.boneMeshes = [];
    this.trunkMesh = null;
    this.headMesh = null;
    this.comSphere = null;
    this.comProjectorLine = null;
    this.comFloorMarker = null;
    this.comTrajectoryLine = null;
    this.chairGroup = null;

    this.allFrames = [];
    this.currentFrameIndex = 0;
    this.currentFrame = null;
    this.isMirrored = false;
    this.rigidBoneLengths = null;

    // InstantHMR body mesh (optional): faces + per-frame vertices, shown instead of the capsule skeleton
    this.meshSequence = null;
    this.bodyMesh = null;
    this.showMesh = true;
    this.meshSmoothingMs = 120;
    this.meshComDisplay = null;

    // Colors
    this.colors = {
      right: 0x0284c7, // Sky Blue
      left: 0xf97316,  // Orange
      trunk: 0x475569, // Slate
      head: 0x64748b,
      com: 0xfbbf24,   // Gold
      floor: 0x1e293b,
      grid: 0x334155,
      chair: 0x94a3b8
    };

    this.init();
  }

  setMirrored(isMirrored) {
    this.isMirrored = !!isMirrored;
    this.updateTrajectoryCurve();
    if (this.currentFrame) {
      this.updateFrame(this.currentFrame);
    }
  }

  init() {
    const width = this.container.clientWidth || 400;
    const height = this.container.clientHeight || 300;

    // 1. Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f172a); // Deep slate background

    // 2. Camera (Perspective)
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 50);
    this.camera.position.set(1.8, 1.0, 2.2);

    // 3. Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.container.innerHTML = "";
    this.container.appendChild(this.renderer.domElement);

    // 4. OrbitControls
    if (window.THREE && window.THREE.OrbitControls) {
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.target.set(0, 0.6, 0);
      this.controls.maxPolarAngle = Math.PI / 2 + 0.1; // Don't go too far below ground
    }

    // 5. Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    this.scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight1.position.set(3, 5, 4);
    dirLight1.castShadow = true;
    this.scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0x94a3b8, 0.4);
    dirLight2.position.set(-3, 3, -3);
    this.scene.add(dirLight2);

    // 6. Environment: Floor & Grid
    this.buildEnvironment();

    // 7. Human 3D Volumetric Mesh & Skeleton
    this.buildBodyModel();

    // 8. CoM Elements & Trajectory
    this.buildComVisualizers();

    // 9. Resize Listener
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.container);

    // 10. Start Animation Loop
    this.animate = this.animate.bind(this);
    this.animate();
  }

  buildEnvironment() {
    // Floor Grid
    const gridHelper = new THREE.GridHelper(4, 20, 0x0ea5e9, 0x334155);
    gridHelper.position.y = 0;
    this.scene.add(gridHelper);

    // Subtle Ground Plane to receive shadows
    const planeGeo = new THREE.PlaneGeometry(6, 6);
    const planeMat = new THREE.MeshStandardMaterial({
      color: 0x090d16,
      roughness: 0.8,
      metalness: 0.2
    });
    const ground = new THREE.Mesh(planeGeo, planeMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.005;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  buildBodyModel() {
    this.humanGroup = new THREE.Group();
    this.scene.add(this.humanGroup);

    // Joint Spheres
    const jointIndices = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];
    const sphereGeo = new THREE.SphereGeometry(0.045, 16, 16);

    jointIndices.forEach(idx => {
      const isRight = idx % 2 === 0;
      const mat = new THREE.MeshStandardMaterial({
        color: isRight ? this.colors.right : this.colors.left,
        roughness: 0.3,
        metalness: 0.2
      });
      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.castShadow = true;
      this.jointMeshes[idx] = mesh;
      this.humanGroup.add(mesh);
    });

    // Head Volume Mesh (Sphere)
    const headGeo = new THREE.SphereGeometry(0.09, 20, 20);
    const headMat = new THREE.MeshStandardMaterial({
      color: this.colors.head,
      roughness: 0.4
    });
    this.headMesh = new THREE.Mesh(headGeo, headMat);
    this.headMesh.castShadow = true;
    this.humanGroup.add(this.headMesh);

    // Bones / Limbs Cylinders (Capsule representation)
    const bonePairs = [
      // Right arm
      [12, 14, "right", 0.035],
      [14, 16, "right", 0.03],
      // Left arm
      [11, 13, "left", 0.035],
      [13, 15, "left", 0.03],
      // Right leg
      [24, 26, "right", 0.05],
      [26, 28, "right", 0.042],
      [28, 32, "right", 0.035],
      // Left leg
      [23, 25, "left", 0.05],
      [25, 27, "left", 0.042],
      [27, 31, "left", 0.035],
      // Shoulders & Pelvis bars
      [11, 12, "trunk", 0.04],
      [23, 24, "trunk", 0.045]
    ];

    this.boneConnections = bonePairs.map(([fromIdx, toIdx, side, radius]) => {
      const color = side === "right" ? this.colors.right : (side === "left" ? this.colors.left : this.colors.trunk);
      const cylGeo = new THREE.CylinderGeometry(radius, radius, 1, 12);
      const mat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.35,
        metalness: 0.15
      });
      const mesh = new THREE.Mesh(cylGeo, mat);
      mesh.castShadow = true;
      this.humanGroup.add(mesh);
      return { fromIdx, toIdx, mesh };
    });

    // Torso Volumetric Mesh (Connecting Shoulders and Pelvis)
    const torsoGeo = new THREE.CylinderGeometry(0.12, 0.11, 1, 16);
    const torsoMat = new THREE.MeshStandardMaterial({
      color: this.colors.trunk,
      roughness: 0.4,
      transparent: true,
      opacity: 0.85
    });
    this.torsoMesh = new THREE.Mesh(torsoGeo, torsoMat);
    this.torsoMesh.castShadow = true;
    this.humanGroup.add(this.torsoMesh);
  }

  buildComVisualizers() {
    // 1. 3D CoM Sphere
    const comGeo = new THREE.SphereGeometry(0.065, 24, 24);
    const comMat = new THREE.MeshStandardMaterial({
      color: this.colors.com,
      emissive: 0xd97706,
      emissiveIntensity: 0.4,
      roughness: 0.2
    });
    this.comSphere = new THREE.Mesh(comGeo, comMat);
    this.scene.add(this.comSphere);

    // 2. CoM Projection Line to Floor
    const lineMat = new THREE.LineDashedMaterial({
      color: this.colors.com,
      dashSize: 0.04,
      gapSize: 0.02
    });
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, -1, 0)
    ]);
    this.comProjectorLine = new THREE.Line(lineGeo, lineMat);
    this.comProjectorLine.computeLineDistances();
    this.scene.add(this.comProjectorLine);

    // 3. CoM Floor Projection Ring / Marker
    const ringGeo = new THREE.RingGeometry(0.05, 0.08, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: this.colors.com,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.8
    });
    this.comFloorMarker = new THREE.Mesh(ringGeo, ringMat);
    this.comFloorMarker.rotation.x = -Math.PI / 2;
    this.comFloorMarker.position.y = 0.002;
    this.scene.add(this.comFloorMarker);

    // 4. CoM 3D Trajectory in Space (Golden Line)
    const maxTrailPoints = 400;
    const trajPositions = new Float32Array(maxTrailPoints * 3);
    const trajGeo = new THREE.BufferGeometry();
    trajGeo.setAttribute("position", new THREE.BufferAttribute(trajPositions, 3));
    const trajMat = new THREE.LineBasicMaterial({
      color: 0xfbbf24, // Bright Gold
      linewidth: 4
    });
    this.comTrajectoryLine = new THREE.Line(trajGeo, trajMat);
    this.scene.add(this.comTrajectoryLine);

    // 5. CoM Floor Shadow Trajectory (Projection line on the floor to see BoS relationship)
    const floorTrajPositions = new Float32Array(maxTrailPoints * 3);
    const floorTrajGeo = new THREE.BufferGeometry();
    floorTrajGeo.setAttribute("position", new THREE.BufferAttribute(floorTrajPositions, 3));
    const floorTrajMat = new THREE.LineDashedMaterial({
      color: 0xca8a04,
      dashSize: 0.03,
      gapSize: 0.015
    });
    this.comFloorTrajectoryLine = new THREE.Line(floorTrajGeo, floorTrajMat);
    this.scene.add(this.comFloorTrajectoryLine);
  }

  /**
   * Body mesh from StsMeshEstimator. `frames` is [{ timestampMs, vertices: Float32Array (body-local, metres, y down),
   * ankle: [x, y, z] (mid-ankle in the same frame) }], sorted by time; pass null to go back to the skeleton.
   */
  setMeshSequence(faces, frames) {
    if (!faces || !frames || frames.length === 0) {
      this.meshSequence = null;
      if (this.bodyMesh) this.bodyMesh.visible = false;
      this.setSkeletonVisible(true);
      return;
    }
    this.meshSequence = { faces, frames };
    this.meshShownKey = null;
    if (!this.bodyMesh) {
      const geo = new THREE.BufferGeometry();
      geo.setIndex(new THREE.BufferAttribute(faces, 1));
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(frames[0].vertices.length), 3));
      const mat = new THREE.MeshStandardMaterial({ color: 0x8b7cf6, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
      this.bodyMesh = new THREE.Mesh(geo, mat);
      this.bodyMesh.castShadow = true;
      this.scene.add(this.bodyMesh);
    }
    if (this.currentFrame) this.updateFrame(this.currentFrame);
  }

  /** Temporal smoothing of the displayed mesh: Gaussian sigma in milliseconds (0 = interpolate only). */
  setMeshSmoothing(sigmaMs) {
    this.meshSmoothingMs = Math.max(0, Number(sigmaMs) || 0);
    if (this.currentFrame) this.updateFrame(this.currentFrame);
  }

  /** [[frameIndex, weight], ...] summing to 1 for the mesh shown at `t`. */
  meshFrameWeights(fr, t, sigma) {
    let lo = 0, hi = fr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fr[mid].timestampMs < t) lo = mid + 1; else hi = mid;
    }
    // lo: first frame at or after t
    if (sigma <= 0 || fr.length === 1) {
      if (lo === 0 || fr[lo].timestampMs <= t) return [[lo, 1]];
      const t0 = fr[lo - 1].timestampMs, t1 = fr[lo].timestampMs;
      const a = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return [[lo - 1, 1 - a], [lo, a]];
    }
    const out = [];
    let sum = 0;
    const reach = 3 * sigma;
    for (let k = lo; k < fr.length && fr[k].timestampMs - t <= reach; k++) {
      const d = (fr[k].timestampMs - t) / sigma, w = Math.exp(-0.5 * d * d);
      out.push([k, w]); sum += w;
    }
    for (let k = lo - 1; k >= 0 && t - fr[k].timestampMs <= reach; k--) {
      const d = (fr[k].timestampMs - t) / sigma, w = Math.exp(-0.5 * d * d);
      out.push([k, w]); sum += w;
    }
    if (out.length === 0 || sum <= 0) return [[Math.min(lo, fr.length - 1), 1]];
    for (const e of out) e[1] /= sum;
    return out;
  }

  setMeshVisible(show) {
    this.showMesh = !!show;
    if (this.currentFrame) this.updateFrame(this.currentFrame);
  }

  setSkeletonVisible(show) {
    Object.values(this.jointMeshes).forEach((m) => { m.visible = m.visible && show; });
    this.boneConnections.forEach(({ mesh }) => { mesh.visible = mesh.visible && show; });
    if (this.headMesh) this.headMesh.visible = this.headMesh.visible && show;
    if (this.torsoMesh) this.torsoMesh.visible = this.torsoMesh.visible && show;
  }

  updateMesh(timestampMs) {
    const seq = this.meshSequence;
    const active = !!(seq && this.showMesh && this.bodyMesh);
    if (this.bodyMesh) this.bodyMesh.visible = active;
    if (!active) return;
    this.setSkeletonVisible(false);

    // Temporal smoothing: a Gaussian-weighted average of the frames around `timestampMs` (zero phase, so no lag).
    // It also interpolates between the 25 fps analysis frames, so playback no longer steps from frame to frame.
    const fr = seq.frames;
    const sigma = this.meshSmoothingMs;
    const key = `${timestampMs}|${sigma}|${this.isMirrored}`;
    if (this.meshShownKey === key) return;
    this.meshShownKey = key;

    const weights = this.meshFrameWeights(fr, timestampMs, sigma);

    // Same placement as transformWorldPoint: ankles at the origin, feet on the floor, y up, z towards the viewer.
    // Each frame is taken relative to its own mid-ankle before averaging, as the unsmoothed mesh was placed.
    const sx = this.isMirrored ? -1 : 1;
    const pos = this.bodyMesh.geometry.attributes.position.array;
    pos.fill(0);
    let cx = 0, cy = 0, cz = 0, cw = 0;
    for (const [k, w] of weights) {
      const v = fr[k].vertices, [ax, ay, az] = fr[k].ankle;
      for (let i = 0; i < v.length; i += 3) {
        pos[i] += w * (v[i] - ax);
        pos[i + 1] += w * (ay - v[i + 1]);
        pos[i + 2] += w * (az - v[i + 2]);
      }
      const c = fr[k].com;
      if (c) { cx += w * (c[0] - ax); cy += w * (ay - c[1]); cz += w * (az - c[2]); cw += w; }
    }
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] *= sx;
      pos[i + 1] += 0.05;
    }
    // Centre of mass with the same smoothing, so the marker stays where it belongs inside the mesh
    this.meshComDisplay = cw > 0 ? new THREE.Vector3(sx * cx / cw, Math.max(0.01, cy / cw + 0.05), cz / cw) : null;
    const geo = this.bodyMesh.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }

  loadFrames(frames) {
    this.allFrames = frames || [];
    this.smoothedFrames = this.generateSmoothedFrames(this.allFrames);
    this.rigidBoneLengths = this.computeRigidBoneLengths(this.smoothedFrames.length > 0 ? this.smoothedFrames : this.allFrames);
    this.updateTrajectoryCurve();
    if (this.smoothedFrames.length > 0) {
      this.updateFrame(this.smoothedFrames[0]);
    }
  }

  // 1. Rigid Anatomical Bone Length Identifier (Median of Euclidean distances across frames)
  computeRigidBoneLengths(frames) {
    const dists = {
      shankL: [], shankR: [],
      thighL: [], thighR: [],
      trunkL: [], trunkR: [],
      upperArmL: [], upperArmR: [],
      forearmL: [], forearmR: [],
      pelvisW: [],
      shoulderW: [],
      ankleW: []
    };

    const calcDist = (p1, p2) => {
      if (!p1 || !p2) return null;
      return Math.hypot(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z);
    };

    frames.forEach(f => {
      const w = f.worldLandmarks;
      if (!w) return;
      // Shanks (Knee 25/26 to Ankle 27/28)
      const dSL = calcDist(w[25], w[27]);
      const dSR = calcDist(w[26], w[28]);
      if (dSL && dSL > 0.2 && dSL < 0.65) dists.shankL.push(dSL);
      if (dSR && dSR > 0.2 && dSR < 0.65) dists.shankR.push(dSR);

      // Thighs (Hip 23/24 to Knee 25/26)
      const dTL = calcDist(w[23], w[25]);
      const dTR = calcDist(w[24], w[26]);
      if (dTL && dTL > 0.2 && dTL < 0.65) dists.thighL.push(dTL);
      if (dTR && dTR > 0.2 && dTR < 0.65) dists.thighR.push(dTR);

      // Torso / Trunk (Hip 23/24 to Shoulder 11/12)
      const dTrunkL = calcDist(w[23], w[11]);
      const dTrunkR = calcDist(w[24], w[12]);
      if (dTrunkL && dTrunkL > 0.25 && dTrunkL < 0.75) dists.trunkL.push(dTrunkL);
      if (dTrunkR && dTrunkR > 0.25 && dTrunkR < 0.75) dists.trunkR.push(dTrunkR);

      // Upper Arms (Shoulder 11/12 to Elbow 13/14)
      const dAL = calcDist(w[11], w[13]);
      const dAR = calcDist(w[12], w[14]);
      if (dAL && dAL > 0.15 && dAL < 0.5) dists.upperArmL.push(dAL);
      if (dAR && dAR > 0.15 && dAR < 0.5) dists.upperArmR.push(dAR);

      // Forearms (Elbow 13/14 to Wrist 15/16)
      const dFL = calcDist(w[13], w[15]);
      const dFR = calcDist(w[14], w[16]);
      if (dFL && dFL > 0.12 && dFL < 0.45) dists.forearmL.push(dFL);
      if (dFR && dFR > 0.12 && dFR < 0.45) dists.forearmR.push(dFR);

      // Stances
      const dPelvis = calcDist(w[23], w[24]);
      const dShoulder = calcDist(w[11], w[12]);
      const dAnkle = calcDist(w[27], w[28]);
      if (dPelvis && dPelvis > 0.12 && dPelvis < 0.45) dists.pelvisW.push(dPelvis);
      if (dShoulder && dShoulder > 0.18 && dShoulder < 0.55) dists.shoulderW.push(dShoulder);
      if (dAnkle && dAnkle > 0.10 && dAnkle < 0.50) dists.ankleW.push(dAnkle);
    });

    const median = (arr, fallback) => {
      if (!arr || arr.length === 0) return fallback;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };

    const shankMedian = (median(dists.shankL, 0.42) + median(dists.shankR, 0.42)) / 2;
    const thighMedian = (median(dists.thighL, 0.42) + median(dists.thighR, 0.42)) / 2;
    const trunkMedian = (median(dists.trunkL, 0.48) + median(dists.trunkR, 0.48)) / 2;
    const upperArmMedian = (median(dists.upperArmL, 0.28) + median(dists.upperArmR, 0.28)) / 2;
    const forearmMedian = (median(dists.forearmL, 0.25) + median(dists.forearmR, 0.25)) / 2;

    return {
      shank: shankMedian,
      thigh: thighMedian,
      trunk: trunkMedian,
      upperArm: upperArmMedian,
      forearm: forearmMedian,
      pelvisW: median(dists.pelvisW, 0.26),
      shoulderW: median(dists.shoulderW, 0.36),
      ankleW: median(dists.ankleW, 0.22)
    };
  }

  // 2. Temporal Smoothing Filter (Applies Gaussian weighted moving average across frames)
  generateSmoothedFrames(frames, ref) {
    if (!frames || frames.length === 0) return [];
    const N = frames.length;
    const smoothed = [];
    const windowWeights = [0.08, 0.20, 0.44, 0.20, 0.08]; // 5-tap Gaussian-like filter

    for (let i = 0; i < N; i++) {
      const f = frames[i];
      const wlm = f.worldLandmarks;
      if (!wlm || Object.keys(wlm).length < 10) {
        smoothed.push(f);
        continue;
      }

      const smoothedWlm = {};
      const indices = Object.keys(wlm).map(k => parseInt(k));

      indices.forEach(idx => {
        let sumX = 0, sumY = 0, sumZ = 0, totalW = 0;
        for (let w = -2; w <= 2; w++) {
          const sampleIdx = Math.max(0, Math.min(N - 1, i + w));
          const sampleWlm = frames[sampleIdx].worldLandmarks;
          if (sampleWlm && sampleWlm[idx]) {
            const weight = windowWeights[w + 2];
            sumX += sampleWlm[idx].x * weight;
            sumY += sampleWlm[idx].y * weight;
            sumZ += sampleWlm[idx].z * weight;
            totalW += weight;
          }
        }
        if (totalW > 0) {
          smoothedWlm[idx] = {
            x: sumX / totalW,
            y: sumY / totalW,
            z: sumZ / totalW,
            visibility: wlm[idx]?.visibility ?? 1.0
          };
        } else {
          smoothedWlm[idx] = wlm[idx];
        }
      });

      // Also smooth 2D landmarks if present
      const smoothedLm = {};
      if (f.landmarks) {
        Object.keys(f.landmarks).forEach(idxStr => {
          const idx = parseInt(idxStr);
          let sumX = 0, sumY = 0, totalW = 0;
          for (let w = -2; w <= 2; w++) {
            const sampleIdx = Math.max(0, Math.min(N - 1, i + w));
            const pt = frames[sampleIdx].landmarks ? frames[sampleIdx].landmarks[idx] : null;
            if (pt) {
              const weight = windowWeights[w + 2];
              sumX += pt.x * weight;
              sumY += pt.y * weight;
              totalW += weight;
            }
          }
          smoothedLm[idx] = totalW > 0 ? { x: sumX / totalW, y: sumY / totalW } : f.landmarks[idx];
        });
      }

      smoothed.push({
        ...f,
        worldLandmarks: smoothedWlm,
        landmarks: smoothedLm
      });
    }

    return smoothed;
  }

  updateTrajectoryCurve() {
    const framesToUse = this.smoothedFrames && this.smoothedFrames.length > 0 ? this.smoothedFrames : this.allFrames;
    if (!framesToUse || framesToUse.length === 0) return;

    const points = [];
    for (let i = 0; i < framesToUse.length; i++) {
      const f = framesToUse[i];
      const pos = this.getFrameCom3D(f);
      if (pos) points.push(pos);
    }

    if (points.length < 2) return;

    const posAttr = this.comTrajectoryLine.geometry.attributes.position;
    const floorPosAttr = this.comFloorTrajectoryLine.geometry.attributes.position;
    const count = Math.min(points.length, posAttr.count);

    for (let i = 0; i < count; i++) {
      posAttr.setXYZ(i, points[i].x, points[i].y, points[i].z);
      floorPosAttr.setXYZ(i, points[i].x, 0.002, points[i].z);
    }
    this.comTrajectoryLine.geometry.setDrawRange(0, count);
    this.comFloorTrajectoryLine.geometry.setDrawRange(0, count);
    posAttr.needsUpdate = true;
    floorPosAttr.needsUpdate = true;
    this.comFloorTrajectoryLine.computeLineDistances();
  }

  getAnkleReference(wlm) {
    if (!wlm) return { x: 0, y: 0.85, z: 0 };
    const ankL = wlm[27];
    const ankR = wlm[28];
    if (ankL && ankR) {
      return {
        x: (ankL.x + ankR.x) / 2,
        y: (ankL.y + ankR.y) / 2,
        z: (ankL.z + ankR.z) / 2
      };
    } else if (ankL) {
      return { x: ankL.x, y: ankL.y, z: ankL.z };
    } else if (ankR) {
      return { x: ankR.x, y: ankR.y, z: ankR.z };
    }
    return { x: 0, y: 0.85, z: 0 };
  }

  transformWorldPoint(pt, ref) {
    if (!pt) return null;
    const xVal = pt.x - ref.x;
    const yVal = Math.max(0.01, (ref.y - pt.y) + 0.05); // 足部接地位置 Y=0.05m（床面上）
    return new THREE.Vector3(
      xVal,
      yVal,
      -(pt.z - ref.z) // 前後方向: MediaPipe本来の奥行き
    );
  }

  // 2. Solve Rigid Anatomical Skeleton (Preserves Segment Lengths from Ankle Base to Head)
  solveRigidSkeleton(rawJoints) {
    if (!rawJoints) return rawJoints;
    const b = this.rigidBoneLengths || {
      shank: 0.42,
      thigh: 0.42,
      trunk: 0.48,
      upperArm: 0.28,
      forearm: 0.25,
      pelvisW: 0.26,
      shoulderW: 0.36,
      ankleW: 0.22
    };

    const r = {};
    for (const k in rawJoints) {
      if (rawJoints[k]) r[k] = rawJoints[k].clone();
    }

    // 1. 足首 (27: Left Ankle, 28: Right Ankle) は床面接地固定 (Y=0.05, Z=0)
    let pAnkL = r[27];
    let pAnkR = r[28];
    const halfAnkW = b.ankleW / 2;
    if (pAnkL && pAnkR) {
      pAnkL.set(-halfAnkW, 0.05, 0.0);
      pAnkR.set(halfAnkW, 0.05, 0.0);
    } else if (pAnkL) {
      pAnkL.set(-halfAnkW, 0.05, 0.0);
    } else if (pAnkR) {
      pAnkR.set(halfAnkW, 0.05, 0.0);
    }

    // 2. 膝 (25: Left Knee, 26: Right Knee) - 足首起点で下腿長 b.shank を固定
    if (r[25] && pAnkL) {
      const dirKneeL = new THREE.Vector3().subVectors(r[25], pAnkL).normalize();
      if (dirKneeL.lengthSq() < 0.001 || dirKneeL.y < 0) dirKneeL.set(0, 0.95, 0.3).normalize();
      r[25] = new THREE.Vector3().copy(pAnkL).addScaledVector(dirKneeL, b.shank);
    }
    if (r[26] && pAnkR) {
      const dirKneeR = new THREE.Vector3().subVectors(r[26], pAnkR).normalize();
      if (dirKneeR.lengthSq() < 0.001 || dirKneeR.y < 0) dirKneeR.set(0, 0.95, 0.3).normalize();
      r[26] = new THREE.Vector3().copy(pAnkR).addScaledVector(dirKneeR, b.shank);
    }

    // 3. 股関節 (23: Left Hip, 24: Right Hip) - 膝起点で大腿長 b.thigh を固定
    if (r[23] && r[25]) {
      const dirHipL = new THREE.Vector3().subVectors(r[23], r[25]).normalize();
      if (dirHipL.lengthSq() < 0.001 || dirHipL.y < 0) dirHipL.set(0, 0.95, -0.3).normalize();
      r[23] = new THREE.Vector3().copy(r[25]).addScaledVector(dirHipL, b.thigh);
    }
    if (r[24] && r[26]) {
      const dirHipR = new THREE.Vector3().subVectors(r[24], r[26]).normalize();
      if (dirHipR.lengthSq() < 0.001 || dirHipR.y < 0) dirHipR.set(0, 0.95, -0.3).normalize();
      r[24] = new THREE.Vector3().copy(r[26]).addScaledVector(dirHipR, b.thigh);
    }

    // 4. 肩 (11: Left Shoulder, 12: Right Shoulder) - 股関節起点で体幹長 b.trunk を固定
    if (r[11] && r[23]) {
      const dirShL = new THREE.Vector3().subVectors(r[11], r[23]).normalize();
      if (dirShL.lengthSq() < 0.001 || dirShL.y < 0) dirShL.set(0, 0.98, 0.1).normalize();
      r[11] = new THREE.Vector3().copy(r[23]).addScaledVector(dirShL, b.trunk);
    }
    if (r[12] && r[24]) {
      const dirShR = new THREE.Vector3().subVectors(r[12], r[24]).normalize();
      if (dirShR.lengthSq() < 0.001 || dirShR.y < 0) dirShR.set(0, 0.98, 0.1).normalize();
      r[12] = new THREE.Vector3().copy(r[24]).addScaledVector(dirShR, b.trunk);
    }

    // 5. 腕 (13, 14: 肘, 15, 16: 手首) - 上腕長・前腕長を固定
    if (r[13] && r[11]) {
      const dirElbL = new THREE.Vector3().subVectors(r[13], r[11]).normalize();
      r[13] = new THREE.Vector3().copy(r[11]).addScaledVector(dirElbL, b.upperArm);
    }
    if (r[14] && r[12]) {
      const dirElbR = new THREE.Vector3().subVectors(r[14], r[12]).normalize();
      r[14] = new THREE.Vector3().copy(r[12]).addScaledVector(dirElbR, b.upperArm);
    }
    if (r[15] && r[13]) {
      const dirWriL = new THREE.Vector3().subVectors(r[15], r[13]).normalize();
      r[15] = new THREE.Vector3().copy(r[13]).addScaledVector(dirWriL, b.forearm);
    }
    if (r[16] && r[14]) {
      const dirWriR = new THREE.Vector3().subVectors(r[16], r[14]).normalize();
      r[16] = new THREE.Vector3().copy(r[14]).addScaledVector(dirWriR, b.forearm);
    }

    // 6. 頭部 (0: Nose)
    if (r[11] && r[12]) {
      const midSh = new THREE.Vector3().addVectors(r[11], r[12]).multiplyScalar(0.5);
      r[0] = new THREE.Vector3(midSh.x, midSh.y + 0.22, midSh.z + 0.04);
    }

    // 7. つま先 (31: Left Toe, 32: Right Toe)
    if (pAnkL) r[31] = new THREE.Vector3(pAnkL.x, 0.02, pAnkL.z + 0.14);
    if (pAnkR) r[32] = new THREE.Vector3(pAnkR.x, 0.02, pAnkR.z + 0.14);

    return r;
  }

  // 3. Get Full 3D Joints with Rigid Bone Preservation and In-Camera Mirroring
  getFrameJoints3D(frame) {
    if (!frame) return null;
    const wlm = frame.worldLandmarks;
    const has3D = wlm && Object.keys(wlm).length >= 10;
    const ref = this.getAnkleReference(wlm);

    const rawJoints = {};
    if (has3D) {
      const tracked = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];
      tracked.forEach(idx => {
        if (wlm[idx]) {
          rawJoints[idx] = this.transformWorldPoint(wlm[idx], ref);
        }
      });
    } else if (frame.landmarks) {
      // 2D fallback
      const tracked = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];
      tracked.forEach(idx => {
        const pt = frame.landmarks[idx];
        if (pt) {
          rawJoints[idx] = new THREE.Vector3(
            (pt.x - 0.5) * 1.2,
            Math.max(0.05, (1.0 - pt.y) * 1.5),
            0
          );
        }
      });
    }

    if (Object.keys(rawJoints).length === 0) return null;

    // Rigid Bone Length Normalization
    const rigidJoints = this.solveRigidSkeleton(rawJoints);

    // In-Camera Mirroring: Swap left/right limbs & negate X coordinate
    if (this.isMirrored) {
      const swapPairs = {
        11: 12, 12: 11,
        13: 14, 14: 13,
        15: 16, 16: 15,
        23: 24, 24: 23,
        25: 26, 26: 25,
        27: 28, 28: 27,
        31: 32, 32: 31,
        0: 0
      };
      const mirroredJoints = {};
      for (const idx in rigidJoints) {
        const targetIdx = swapPairs[idx] !== undefined ? swapPairs[idx] : idx;
        const pt = rigidJoints[idx];
        mirroredJoints[targetIdx] = new THREE.Vector3(-pt.x, pt.y, pt.z);
      }
      return mirroredJoints;
    }

    return rigidJoints;
  }

  getFrameCom3D(frame) {
    if (!frame) return null;
    // Mesh CoM (InstantHMR): same placement as the mesh and the joints, so it sits inside the body
    if (frame.meshCom?.world && frame.worldLandmarks && Object.keys(frame.worldLandmarks).length >= 10) {
      const p = this.transformWorldPoint(frame.meshCom.world, this.getAnkleReference(frame.worldLandmarks));
      if (this.isMirrored) p.x = -p.x;
      return p;
    }
    const joints = this.getFrameJoints3D(frame);
    if (joints && joints[23] && joints[24] && joints[11] && joints[12] && joints[27] && joints[28]) {
      const midSh = new THREE.Vector3().addVectors(joints[11], joints[12]).multiplyScalar(0.5);
      const midHip = new THREE.Vector3().addVectors(joints[23], joints[24]).multiplyScalar(0.5);
      const midAnk = new THREE.Vector3().addVectors(joints[27], joints[28]).multiplyScalar(0.5);

      // Dempster / Winter 3-segment biomechanical CoM model
      const cx = 0.35 * midSh.x + 0.35 * midHip.x + 0.30 * midAnk.x;
      const cy = 0.35 * midSh.y + 0.35 * midHip.y + 0.30 * midAnk.y;
      const cz = 0.35 * midSh.z + 0.35 * midHip.z + 0.30 * midAnk.z;

      return new THREE.Vector3(cx, cy, cz);
    }

    const fxVal = (frame.comX - 0.5) * 1.2;
    const fx = this.isMirrored ? -fxVal : fxVal;
    const fy = Math.max(0.1, (1.0 - frame.comY) * 1.5);
    const fz = (frame.comZ || 0);
    return new THREE.Vector3(fx, fy, fz);
  }

  // Continuous Sub-frame Time Interpolator (Lerp for ultra-smooth 60fps playback)
  updateAtTimestamp(timestampMs) {
    const frames = this.smoothedFrames && this.smoothedFrames.length > 0 ? this.smoothedFrames : this.allFrames;
    if (!frames || frames.length === 0) return;

    if (frames.length === 1 || timestampMs <= frames[0].timestampMs) {
      this.updateFrame(frames[0]);
      return;
    }
    const last = frames[frames.length - 1];
    if (timestampMs >= last.timestampMs) {
      this.updateFrame(last);
      return;
    }

    // Binary search or linear search for surrounding frames
    let i = 0;
    while (i < frames.length - 1 && frames[i + 1].timestampMs <= timestampMs) {
      i++;
    }
    const f0 = frames[i];
    const f1 = frames[i + 1];

    const dt = f1.timestampMs - f0.timestampMs;
    const alpha = dt > 0 ? Math.max(0, Math.min(1, (timestampMs - f0.timestampMs) / dt)) : 0;

    // Interpolate worldLandmarks
    const interpWlm = {};
    if (f0.worldLandmarks && f1.worldLandmarks) {
      for (const k in f0.worldLandmarks) {
        const p0 = f0.worldLandmarks[k];
        const p1 = f1.worldLandmarks[k];
        if (p0 && p1) {
          interpWlm[k] = {
            x: p0.x + (p1.x - p0.x) * alpha,
            y: p0.y + (p1.y - p0.y) * alpha,
            z: p0.z + (p1.z - p0.z) * alpha,
            visibility: p0.visibility
          };
        } else {
          interpWlm[k] = p0 || p1;
        }
      }
    }

    // Interpolate 2D landmarks
    const interpLm = {};
    if (f0.landmarks && f1.landmarks) {
      for (const k in f0.landmarks) {
        const p0 = f0.landmarks[k];
        const p1 = f1.landmarks[k];
        if (p0 && p1) {
          interpLm[k] = {
            x: p0.x + (p1.x - p0.x) * alpha,
            y: p0.y + (p1.y - p0.y) * alpha
          };
        } else {
          interpLm[k] = p0 || p1;
        }
      }
    }

    const interpFrame = {
      ...f0,
      timestampMs,
      worldLandmarks: interpWlm,
      landmarks: interpLm,
      comX: f0.comX + (f1.comX - f0.comX) * alpha,
      comY: f0.comY + (f1.comY - f0.comY) * alpha,
      midBaseX: f0.midBaseX + (f1.midBaseX - f0.midBaseX) * alpha,
      meshCom: (f0.meshCom?.world && f1.meshCom?.world) ? {
        ...f0.meshCom,
        world: {
          x: f0.meshCom.world.x + (f1.meshCom.world.x - f0.meshCom.world.x) * alpha,
          y: f0.meshCom.world.y + (f1.meshCom.world.y - f0.meshCom.world.y) * alpha,
          z: f0.meshCom.world.z + (f1.meshCom.world.z - f0.meshCom.world.z) * alpha
        }
      } : f0.meshCom
    };

    this.updateFrame(interpFrame);
  }

  updateFrame(frame) {
    if (!frame) return;
    this.currentFrame = frame;

    const joints = this.getFrameJoints3D(frame);
    if (!joints) return;

    // 1. Update Joint Spheres
    Object.entries(this.jointMeshes).forEach(([idxStr, mesh]) => {
      const idx = parseInt(idxStr);
      const pos = joints[idx];
      if (pos) {
        mesh.position.copy(pos);
        mesh.visible = true;
      } else {
        mesh.visible = false;
      }
    });

    // 2. Update Bones (Cylinders)
    this.boneConnections.forEach(({ fromIdx, toIdx, mesh }) => {
      const p1 = joints[fromIdx];
      const p2 = joints[toIdx];
      if (p1 && p2) {
        mesh.visible = true;
        this.positionCylinderBetweenPoints(mesh, p1, p2);
      } else {
        mesh.visible = false;
      }
    });

    // 3. Update Head
    const pNose = joints[0] || (() => {
      const pShL = joints[11];
      const pShR = joints[12];
      if (pShL && pShR) {
        return new THREE.Vector3().addVectors(pShL, pShR).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.22, 0));
      }
      return null;
    })();

    if (pNose) {
      this.headMesh.position.copy(pNose);
      this.headMesh.visible = true;
    }

    // 4. Update Torso
    const pShL = joints[11];
    const pShR = joints[12];
    const pHipL = joints[23];
    const pHipR = joints[24];

    if (pShL && pShR && pHipL && pHipR) {
      const pMidSh = new THREE.Vector3().addVectors(pShL, pShR).multiplyScalar(0.5);
      const pMidHip = new THREE.Vector3().addVectors(pHipL, pHipR).multiplyScalar(0.5);
      this.positionCylinderBetweenPoints(this.torsoMesh, pMidHip, pMidSh);
      this.torsoMesh.visible = true;
    } else {
      this.torsoMesh.visible = false;
    }

    // 5. InstantHMR body mesh (before the CoM, which follows the smoothed mesh when it is shown)
    this.updateMesh(frame.timestampMs);

    // 6. Update CoM Visualizer
    const meshShown = !!(this.meshSequence && this.showMesh && this.bodyMesh && this.bodyMesh.visible);
    const comPos = (meshShown && this.meshComDisplay) ? this.meshComDisplay.clone() : this.getFrameCom3D(frame);
    if (comPos) {
      this.comSphere.position.copy(comPos);
      this.comFloorMarker.position.set(comPos.x, 0.002, comPos.z);

      // Projector line from CoM down to floor
      const linePos = this.comProjectorLine.geometry.attributes.position;
      linePos.setXYZ(0, comPos.x, comPos.y, comPos.z);
      linePos.setXYZ(1, comPos.x, 0.002, comPos.z);
      linePos.needsUpdate = true;
      this.comProjectorLine.computeLineDistances();

      this.comSphere.visible = true;
      this.comFloorMarker.visible = true;
      this.comProjectorLine.visible = true;
    }

  }

  positionCylinderBetweenPoints(mesh, p1, p2) {
    const distance = p1.distanceTo(p2);
    if (distance < 0.005) {
      mesh.visible = false;
      return;
    }
    mesh.scale.set(1, Math.max(0.01, distance), 1);

    const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
    mesh.position.copy(mid);

    const orientation = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3().subVectors(p2, p1).normalize();

    // Check if dir and up are parallel
    if (Math.abs(dir.y) > 0.9999) {
      mesh.quaternion.set(0, 0, 0, 1);
      if (dir.y < 0) mesh.rotation.x = Math.PI;
    } else {
      const axis = new THREE.Vector3().crossVectors(up, dir).normalize();
      const angle = Math.acos(Math.max(-1.0, Math.min(1.0, up.dot(dir))));
      mesh.quaternion.setFromAxisAngle(axis, angle);
    }
  }

  setCameraView(viewName) {
    if (!this.camera || !this.controls) return;

    switch (viewName) {
      case "sagittal": // Lateral / Sagittal view (Right to Left)
        this.camera.position.set(2.4, 0.75, 0.0);
        this.controls.target.set(0, 0.65, 0);
        break;
      case "frontal": // Frontal view
        this.camera.position.set(0.0, 0.8, 2.5);
        this.controls.target.set(0, 0.65, 0);
        break;
      case "perspective": // 3/4 Perspective 3D
        this.camera.position.set(1.8, 1.1, 2.2);
        this.controls.target.set(0, 0.65, 0);
        break;
      case "top": // Top-down / Transverse view
        this.camera.position.set(0.0, 3.2, 0.05);
        this.controls.target.set(0, 0, 0);
        break;
      default:
        this.camera.position.set(1.8, 1.1, 2.2);
        this.controls.target.set(0, 0.65, 0);
        break;
    }
    this.controls.update();
  }

  onResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  animate() {
    this.animationFrameId = requestAnimationFrame(this.animate);
    if (this.controls) {
      this.controls.update();
    }
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  destroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.renderer && this.renderer.domElement) {
      this.renderer.domElement.remove();
      this.renderer.dispose();
    }
  }
}
