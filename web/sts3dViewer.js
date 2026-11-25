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

  loadFrames(frames) {
    this.allFrames = frames || [];
    this.smoothedFrames = this.generateSmoothedFrames(this.allFrames);
    this.updateTrajectoryCurve();
    if (this.smoothedFrames.length > 0) {
      this.updateFrame(this.smoothedFrames[0]);
    }
  }

  // Temporal Smoothing Filter (Applies Gaussian weighted moving average across frames for silky motion)
  generateSmoothedFrames(frames) {
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

  // Per-frame Foot Anchor: Grounds the ankles strictly to (0, 0.05, 0) on the floor.
  // Since MediaPipe worldLandmarks places (0,0,0) at the moving pelvis, subtracting the
  // frame's ankle ground reference ensures the feet remain immobile on the floor while the body rises!
  getAnkleReference(wlm) {
    if (!wlm) return { x: 0, y: 0.85, z: 0 };
    const ankL = wlm[27];
    const ankR = wlm[28];
    if (ankL && ankR) {
      return {
        x: (ankL.x + ankR.x) / 2,
        y: Math.max(ankL.y, ankR.y), // MediaPipe: Y is downward, so foot ground contact has maximum Y
        z: (ankL.z + ankR.z) / 2
      };
    }
    if (ankL) return { x: ankL.x, y: ankL.y, z: ankL.z };
    if (ankR) return { x: ankR.x, y: ankR.y, z: ankR.z };
    return { x: 0, y: 0.85, z: 0 };
  }

  transformWorldPoint(pt, ref) {
    if (!pt) return null;
    return new THREE.Vector3(
      pt.x - ref.x,              // 左右: 両足首の中点を X=0 に固定
      (ref.y - pt.y) + 0.05,     // 高さ: 足首接地位置を床面 Y=0.05m に固定。骨盤・体幹・CoMが上方へ立ち上がる！
      -(pt.z - ref.z)            // 前後: 足首を Z=0 に固定。着座時は後方(Z<0)、立ち上がりで前方(Z~0)へ！
    );
  }

  getFrameCom3D(frame) {
    if (!frame) return null;
    const wlm = frame.worldLandmarks;
    if (wlm && wlm[23] && wlm[24] && wlm[11] && wlm[12]) {
      const ref = this.getAnkleReference(wlm);

      const pShL = this.transformWorldPoint(wlm[11], ref);
      const pShR = this.transformWorldPoint(wlm[12], ref);
      const pHipL = this.transformWorldPoint(wlm[23], ref);
      const pHipR = this.transformWorldPoint(wlm[24], ref);
      const pAnkL = wlm[27] ? this.transformWorldPoint(wlm[27], ref) : pHipL;
      const pAnkR = wlm[28] ? this.transformWorldPoint(wlm[28], ref) : pHipR;

      const midSh = new THREE.Vector3().addVectors(pShL, pShR).multiplyScalar(0.5);
      const midHip = new THREE.Vector3().addVectors(pHipL, pHipR).multiplyScalar(0.5);
      const midAnk = new THREE.Vector3().addVectors(pAnkL, pAnkR).multiplyScalar(0.5);

      // 3-segment biomechanical CoM model
      const cx = 0.35 * midSh.x + 0.35 * midHip.x + 0.30 * midAnk.x;
      const cy = 0.35 * midSh.y + 0.35 * midHip.y + 0.30 * midAnk.y;
      const cz = 0.35 * midSh.z + 0.35 * midHip.z + 0.30 * midAnk.z;

      return new THREE.Vector3(cx, cy, cz);
    }

    const baseFootY = (frame.landmarks && (frame.landmarks[27] || frame.landmarks[28]))
      ? Math.max(frame.landmarks[27]?.y ?? 0.85, frame.landmarks[28]?.y ?? 0.85)
      : 0.85;
    const baseFootX = (frame.landmarks && (frame.landmarks[27] || frame.landmarks[28]))
      ? (((frame.landmarks[27]?.x ?? 0.5) + (frame.landmarks[28]?.x ?? 0.5)) / 2)
      : 0.5;
    const fx = (frame.comX - baseFootX) * 1.2;
    const fy = Math.max(0.05, (baseFootY - frame.comY) * 1.5 + 0.05);
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
      midBaseX: f0.midBaseX + (f1.midBaseX - f0.midBaseX) * alpha
    };

    this.updateFrame(interpFrame);
  }

  updateFrame(frame) {
    if (!frame) return;

    const wlm = frame.worldLandmarks;
    const has3D = wlm && Object.keys(wlm).length >= 10;
    const ref = this.getAnkleReference(wlm);

    const get3DPos = (idx) => {
      if (has3D && wlm[idx]) {
        return this.transformWorldPoint(wlm[idx], ref);
      }
      // Fallback
      const lm2 = frame.landmarks ? frame.landmarks[idx] : null;
      if (lm2) {
        const baseFootY = (frame.landmarks[27] || frame.landmarks[28])
          ? Math.max(frame.landmarks[27]?.y ?? 0.85, frame.landmarks[28]?.y ?? 0.85)
          : 0.85;
        const baseFootX = (frame.landmarks[27] || frame.landmarks[28])
          ? (((frame.landmarks[27]?.x ?? 0.5) + (frame.landmarks[28]?.x ?? 0.5)) / 2)
          : 0.5;
        return new THREE.Vector3(
          (lm2.x - baseFootX) * 1.2,
          Math.max(0.02, (baseFootY - lm2.y) * 1.5 + 0.05),
          0
        );
      }
      return null;
    };

    // 1. Update Joint Spheres
    Object.entries(this.jointMeshes).forEach(([idxStr, mesh]) => {
      const idx = parseInt(idxStr);
      const pos = get3DPos(idx);
      if (pos) {
        mesh.position.copy(pos);
        mesh.visible = true;
      } else {
        mesh.visible = false;
      }
    });

    // 2. Update Bones (Cylinders)
    this.boneConnections.forEach(({ fromIdx, toIdx, mesh }) => {
      const p1 = get3DPos(fromIdx);
      const p2 = get3DPos(toIdx);
      if (p1 && p2) {
        mesh.visible = true;
        this.positionCylinderBetweenPoints(mesh, p1, p2);
      } else {
        mesh.visible = false;
      }
    });

    // 3. Update Head
    const pNose = get3DPos(0) || (() => {
      const pShL = get3DPos(11);
      const pShR = get3DPos(12);
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
    const pShL = get3DPos(11);
    const pShR = get3DPos(12);
    const pHipL = get3DPos(23);
    const pHipR = get3DPos(24);

    if (pShL && pShR && pHipL && pHipR) {
      const pMidSh = new THREE.Vector3().addVectors(pShL, pShR).multiplyScalar(0.5);
      const pMidHip = new THREE.Vector3().addVectors(pHipL, pHipR).multiplyScalar(0.5);
      this.positionCylinderBetweenPoints(this.torsoMesh, pMidHip, pMidSh);
      this.torsoMesh.visible = true;
    } else {
      this.torsoMesh.visible = false;
    }

    // 5. Update CoM Visualizer
    const comPos = this.getFrameCom3D(frame);
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
