/**
 * STS 3D Biomechanical Mesh & Skeleton Viewer (Three.js)
 * High-precision Biomechanical Kinematic Rig Reconstructor
 * - True foot ground symmetry constraint (feet locked in parallel on floor)
 * - 2-link geometric inverse kinematics (IK) for knee and thigh
 * - Rigid segment length preservation (no bone warping)
 * - Dempster/Winter anatomical center-of-mass (CoM) distribution
 * - In-camera self-mirroring support
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
    this.comFloorTrajectoryLine = null;

    this.allFrames = [];
    this.smoothedFrames = [];
    this.currentFrame = null;
    this.currentFrameIndex = 0;
    this.isMirrored = false;

    // Dynamic calibration of leg span progression
    this.minLegSpan = 0.22;
    this.maxLegSpan = 0.48;

    // Colors
    this.colors = {
      right: 0x0284c7, // Sky Blue (Right limb)
      left: 0xf97316,  // Orange (Left limb)
      trunk: 0x475569, // Slate
      head: 0x64748b,
      com: 0xfbbf24,   // Gold
      floor: 0x1e293b,
      grid: 0x334155
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
      this.controls.maxPolarAngle = Math.PI / 2 + 0.1;
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
    const jointIndices = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
    const sphereGeo = new THREE.SphereGeometry(0.042, 16, 16);

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
      [24, 26, "right", 0.048],
      [26, 28, "right", 0.04],
      [28, 32, "right", 0.032],
      // Left leg
      [23, 25, "left", 0.048],
      [25, 27, "left", 0.04],
      [27, 31, "left", 0.032],
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
      color: 0xfbbf24,
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

  loadFrames(frames) {
    this.allFrames = frames || [];
    this.calibrateLegSpans(this.allFrames);
    this.smoothedFrames = this.generateSmoothedFrames(this.allFrames);
    this.updateTrajectoryCurve();
    if (this.smoothedFrames.length > 0) {
      this.updateFrame(this.smoothedFrames[0]);
    }
  }

  calibrateLegSpans(frames) {
    if (!frames || frames.length === 0) return;
    let minSpan = 999;
    let maxSpan = -999;
    for (const f of frames) {
      const lm = f.landmarks;
      if (lm && lm[23] && lm[24] && lm[27] && lm[28]) {
        const hipY = (lm[23].y + lm[24].y) / 2;
        const ankY = (lm[27].y + lm[28].y) / 2;
        const span = ankY - hipY;
        if (span < minSpan) minSpan = span;
        if (span > maxSpan) maxSpan = span;
      }
    }
    if (minSpan < maxSpan && maxSpan - minSpan > 0.05) {
      this.minLegSpan = minSpan;
      this.maxLegSpan = maxSpan;
    }
  }

  // 5-tap Gaussian temporal smoothing across frames
  generateSmoothedFrames(frames) {
    if (!frames || frames.length === 0) return [];
    const N = frames.length;
    const smoothed = [];
    const windowWeights = [0.08, 0.20, 0.44, 0.20, 0.08];

    for (let i = 0; i < N; i++) {
      const f = frames[i];
      const lm = f.landmarks;
      if (!lm) {
        smoothed.push(f);
        continue;
      }

      const smoothedLm = {};
      Object.keys(lm).forEach(idxStr => {
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
        smoothedLm[idx] = totalW > 0 ? { x: sumX / totalW, y: sumY / totalW } : lm[idx];
      });

      // Smooth trunkAngleDeg
      let sumTrunk = 0, totalTrunkW = 0;
      for (let w = -2; w <= 2; w++) {
        const sampleIdx = Math.max(0, Math.min(N - 1, i + w));
        const ang = frames[sampleIdx].trunkAngleDeg;
        if (typeof ang === 'number' && !isNaN(ang)) {
          const weight = windowWeights[w + 2];
          sumTrunk += ang * weight;
          totalTrunkW += weight;
        }
      }

      smoothed.push({
        ...f,
        landmarks: smoothedLm,
        trunkAngleDeg: totalTrunkW > 0 ? sumTrunk / totalTrunkW : f.trunkAngleDeg
      });
    }

    return smoothed;
  }

  /**
   * Biomechanical Kinematic Rig Solver
   * - Locks feet symmetrically on floor at Y=0.05, Z=0.
   * - 2-link geometric IK for knees without unilateral forward shifts.
   * - Anatomical mass distribution for CoM.
   * - Fully synchronized with in-camera self-mirroring.
   */
  solveBiomechanicalRig(frame) {
    if (!frame) return { joints: {}, com: new THREE.Vector3(0, 0.5, 0) };

    const lm = frame.landmarks || {};

    // 1. Calculate standing progress alpha [0, 1]
    const hipL = lm[23] || { x: 0.45, y: 0.65 };
    const hipR = lm[24] || { x: 0.55, y: 0.65 };
    const ankL = lm[27] || { x: 0.45, y: 0.88 };
    const ankR = lm[28] || { x: 0.55, y: 0.88 };

    const midHipY = (hipL.y + hipR.y) / 2;
    const midAnkY = (ankL.y + ankR.y) / 2;
    const legSpan2D = Math.max(0.12, midAnkY - midHipY);

    let alpha = 0.0;
    if (this.maxLegSpan > this.minLegSpan + 0.04) {
      alpha = Math.max(0, Math.min(1.0, (legSpan2D - this.minLegSpan) / (this.maxLegSpan - this.minLegSpan)));
    } else {
      alpha = Math.max(0, Math.min(1.0, (legSpan2D - 0.22) / 0.20));
    }

    // 2. Anatomical Segment Constants (Meters, Winter standards)
    const L_shank = 0.42;  // Ankle to Knee
    const L_thigh = 0.42;  // Knee to Hip
    const L_trunk = 0.48;  // Hip to Shoulder
    const W_pelvis = 0.26; // Inter-hip stance
    const W_stance = 0.24; // Inter-ankle stance
    const W_shoulder = 0.36; // Shoulder span

    // 3. Symmetrical Grounded Feet Anchors (Strictly aligned on floor, Z=0 for ankles)
    const joints = {};
    joints[27] = new THREE.Vector3(-W_stance / 2, 0.05, 0.0);   // Left Ankle
    joints[28] = new THREE.Vector3(W_stance / 2, 0.05, 0.0);    // Right Ankle
    joints[29] = new THREE.Vector3(-W_stance / 2, 0.05, -0.06); // Left Heel
    joints[30] = new THREE.Vector3(W_stance / 2, 0.05, -0.06);  // Right Heel
    joints[31] = new THREE.Vector3(-W_stance / 2, 0.05, 0.16);  // Left Toe
    joints[32] = new THREE.Vector3(W_stance / 2, 0.05, 0.16);   // Right Toe

    // 4. Pelvis (Hip) Kinematics
    // Seated: Y ~ 0.43m, Z ~ -0.26m
    // Standing: Y ~ 0.85m, Z ~ +0.01m
    const Y_pelvis = 0.43 + alpha * 0.42;
    const Z_pelvis = -0.26 * (1.0 - alpha * 0.96);
    const X_pelvis = ((frame.leftBiasPercent || 50.0) - 50.0) / 50.0 * 0.05;

    joints[23] = new THREE.Vector3(X_pelvis - W_pelvis / 2, Y_pelvis, Z_pelvis); // Left Hip
    joints[24] = new THREE.Vector3(X_pelvis + W_pelvis / 2, Y_pelvis, Z_pelvis); // Right Hip

    // 5. Knee Joint Kinematics (2-Link Geometric IK)
    // Symmetrical forward flexion; no unilateral anterior displacement!
    const dy = Y_pelvis - 0.05;
    const dz = Z_pelvis;
    const D = Math.max(0.15, Math.min(L_shank + L_thigh - 0.005, Math.sqrt(dy * dy + dz * dz)));

    // Angle via Law of Cosines
    const cosAngle = Math.max(-1.0, Math.min(1.0, (L_shank * L_shank + D * D - L_thigh * L_thigh) / (2 * L_shank * D)));
    const angleBase = Math.acos(cosAngle);
    const angleLine = Math.atan2(dy, -dz);
    const kneeAngle = angleLine - angleBase;

    const Y_knee = 0.05 + L_shank * Math.sin(kneeAngle);
    const Z_knee = -L_shank * Math.cos(kneeAngle);

    joints[25] = new THREE.Vector3(-W_stance / 2, Math.max(0.08, Y_knee), Z_knee); // Left Knee
    joints[26] = new THREE.Vector3(W_stance / 2, Math.max(0.08, Y_knee), Z_knee);  // Right Knee

    // 6. Trunk & Shoulders
    // Derived from measured trunk angle, smoothly transitioning to upright at stand completion
    let trunkDeg = typeof frame.trunkAngleDeg === 'number' ? frame.trunkAngleDeg : (alpha < 0.35 ? 35 * (alpha / 0.35) : 35 * (1.0 - (alpha - 0.35) / 0.65));
    if (alpha > 0.85) trunkDeg = Math.min(trunkDeg, 5.0); // Strict upright standing
    const thetaTrunkRad = (trunkDeg * Math.PI) / 180.0;

    const Y_shoulder = Y_pelvis + L_trunk * Math.cos(thetaTrunkRad);
    const Z_shoulder = Z_pelvis + L_trunk * Math.sin(thetaTrunkRad) * 0.52;

    joints[11] = new THREE.Vector3(X_pelvis - W_shoulder / 2, Y_shoulder, Z_shoulder); // Left Shoulder
    joints[12] = new THREE.Vector3(X_pelvis + W_shoulder / 2, Y_shoulder, Z_shoulder); // Right Shoulder

    // 7. Head (Node 0)
    joints[0] = new THREE.Vector3(X_pelvis, Y_shoulder + 0.22, Z_shoulder + 0.03);

    // 8. Arms & Elbows
    const L_upperArm = 0.27;
    const L_forearm = 0.24;
    joints[13] = new THREE.Vector3(joints[11].x - 0.03, joints[11].y - L_upperArm * 0.85, joints[11].z + L_upperArm * 0.35);
    joints[14] = new THREE.Vector3(joints[12].x + 0.03, joints[12].y - L_upperArm * 0.85, joints[12].z + L_upperArm * 0.35);
    joints[15] = new THREE.Vector3(joints[13].x, joints[13].y - L_forearm * 0.7, joints[13].z + L_forearm * 0.6);
    joints[16] = new THREE.Vector3(joints[14].x, joints[14].y - L_forearm * 0.7, joints[14].z + L_forearm * 0.6);

    // 9. Biomechanical Center of Mass (CoM) - Winter Anatomical Model
    const midSh = new THREE.Vector3().addVectors(joints[11], joints[12]).multiplyScalar(0.5);
    const midHip = new THREE.Vector3().addVectors(joints[23], joints[24]).multiplyScalar(0.5);
    const midKnee = new THREE.Vector3().addVectors(joints[25], joints[26]).multiplyScalar(0.5);
    const midAnk = new THREE.Vector3().addVectors(joints[27], joints[28]).multiplyScalar(0.5);

    const posHAT = new THREE.Vector3().addVectors(midHip, new THREE.Vector3().subVectors(midSh, midHip).multiplyScalar(0.38));
    const posThigh = new THREE.Vector3().addVectors(midHip, new THREE.Vector3().subVectors(midKnee, midHip).multiplyScalar(0.43));
    const posShank = new THREE.Vector3().addVectors(midKnee, new THREE.Vector3().subVectors(midAnk, midKnee).multiplyScalar(0.43));

    const com = new THREE.Vector3()
      .addScaledVector(posHAT, 0.68)
      .addScaledVector(posThigh, 0.20)
      .addScaledVector(posShank, 0.12);

    // 10. Handle In-Camera Mirroring
    if (this.isMirrored) {
      const mirroredJoints = {};
      const swapPairs = {
        11: 12, 12: 11,
        13: 14, 14: 13,
        15: 16, 16: 15,
        23: 24, 24: 23,
        25: 26, 26: 25,
        27: 28, 28: 27,
        29: 30, 30: 29,
        31: 32, 32: 31,
        0: 0
      };
      for (const idx in joints) {
        const targetIdx = swapPairs[idx] !== undefined ? swapPairs[idx] : idx;
        const p = joints[idx];
        mirroredJoints[targetIdx] = new THREE.Vector3(-p.x, p.y, p.z);
      }
      return { joints: mirroredJoints, com: new THREE.Vector3(-com.x, com.y, com.z) };
    }

    return { joints, com };
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

  getFrameCom3D(frame) {
    if (!frame) return null;
    const { com } = this.solveBiomechanicalRig(frame);
    return com;
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

    const t0 = f0.trunkAngleDeg || 0;
    const t1 = f1.trunkAngleDeg || 0;
    const interpTrunk = t0 + (t1 - t0) * alpha;

    const interpFrame = {
      ...f0,
      timestampMs,
      landmarks: interpLm,
      trunkAngleDeg: interpTrunk,
      leftBiasPercent: f0.leftBiasPercent + (f1.leftBiasPercent - f0.leftBiasPercent) * alpha
    };

    this.updateFrame(interpFrame);
  }

  updateFrame(frame) {
    if (!frame) return;
    this.currentFrame = frame;

    const { joints, com } = this.solveBiomechanicalRig(frame);

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
    if (joints[0]) {
      this.headMesh.position.copy(joints[0]);
      this.headMesh.visible = true;
    }

    // 4. Update Torso
    if (joints[11] && joints[12] && joints[23] && joints[24]) {
      const pMidSh = new THREE.Vector3().addVectors(joints[11], joints[12]).multiplyScalar(0.5);
      const pMidHip = new THREE.Vector3().addVectors(joints[23], joints[24]).multiplyScalar(0.5);
      this.positionCylinderBetweenPoints(this.torsoMesh, pMidHip, pMidSh);
      this.torsoMesh.visible = true;
    } else {
      this.torsoMesh.visible = false;
    }

    // 5. Update CoM Visualizer
    if (com) {
      this.comSphere.position.copy(com);
      this.comFloorMarker.position.set(com.x, 0.002, com.z);

      const linePos = this.comProjectorLine.geometry.attributes.position;
      linePos.setXYZ(0, com.x, com.y, com.z);
      linePos.setXYZ(1, com.x, 0.002, com.z);
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
