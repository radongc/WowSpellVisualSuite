// WebGL model viewer for M2 geometry (Z-up) with BLP textures, CPU particle
// simulation, and composite scenes (e.g. mannequin + positioned effect model).
// No dependencies.
//
// API:
//   Viewer.show(geom)                          — single model (back-compat)
//   Viewer.showComposite([{geom, transform, gray, noParticles}, ...])
//   Viewer.setTexture(texIdx, w, h, rgba)      — texture for model 0
//   Viewer.setModelTexture(modelIdx, texIdx, w, h, rgba)
//   Viewer.setTransform(modelIdx, {offset, yaw, pitch, roll, scale})
//   Viewer.setLabDrag(cb|null)                 — shift+drag calls cb([dx,dy,dz])
//   Viewer.clear(), setWireframe(b), setSpin(b), setParticles(b)
const Viewer = (() => {
  const canvas = document.getElementById('gl');
  const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
  if (!gl) {
    return { show() {}, showComposite() {}, clear() {}, setTexture() {}, setModelTexture() {}, setTransform() {}, setVisible() {}, setPanEnabled() {}, setLabDrag() {}, setWireframe() {}, setSpin() {}, setParticles() {}, setBrightness() {}, setBackground() {}, backgroundLevels: 3, setAnimation() {}, getAnimation() { return -1; } };
  }
  let models = [];            // [{ mesh, textures, emitters, transform, gray }]
  let sceneCenter = [0, 0, 0.5], sceneRadius = 1;
  let wireframe = false, spin = true, particlesOn = true;
  let yaw = 0.6, pitch = 0.35, dist = 3;
  let pan = [0, 0, 0];        // camera target offset (lab panning)
  let dragging = false, lastX = 0, lastY = 0, labDragCb = null, labDragging = false;
  let panning = false, panEnabled = false;
  let lastT = 0;
  // gizmo state (lab mode: models[1] is the positioned effect)
  let lastMvp = null, lastRight = [1, 0, 0], lastUp = [0, 0, 1];
  let gizmoAxis = -1, hoverAxis = -1, gizmoDrag = null;
  const AXIS_DIRS = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const AXIS_COLORS = [[0.95, 0.35, 0.35], [0.35, 0.9, 0.4], [0.4, 0.62, 0.98]];

  // ---------- shaders ----------
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    return p;
  }

  const meshProg = program(`
    attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUV;
    uniform mat4 uMVP; uniform mat4 uModel;
    varying vec3 vNrm; varying vec2 vUV;
    void main() {
      gl_Position = uMVP * vec4(aPos, 1.0);
      vNrm = mat3(uModel) * aNrm;
      vUV = aUV;
    }`, `
    precision mediump float;
    varying vec3 vNrm; varying vec2 vUV;
    uniform vec3 uColor; uniform float uFlat; uniform float uHasTex;
    uniform float uAlphaTest; uniform sampler2D uTex; uniform float uBright;
    void main() {
      vec3 n = normalize(vNrm);
      float d1 = max(dot(n, normalize(vec3(0.5, 0.6, 0.8))), 0.0);
      float d2 = max(dot(n, normalize(vec3(-0.6, -0.3, 0.4))), 0.0) * 0.35;
      float l = mix(min(0.78 + 0.4 * d1 + d2, 1.3), 1.0, uFlat);
      vec4 tex = mix(vec4(1.0), texture2D(uTex, vUV), uHasTex);
      if (uAlphaTest > 0.5 && tex.a < 0.5) discard;
      gl_FragColor = vec4(uColor * l * tex.rgb * uBright, tex.a);
    }`);
  const mLoc = {};
  for (const a of ['aPos', 'aNrm', 'aUV']) mLoc[a] = gl.getAttribLocation(meshProg, a);
  for (const u of ['uMVP', 'uModel', 'uColor', 'uFlat', 'uHasTex', 'uAlphaTest', 'uTex', 'uBright']) mLoc[u] = gl.getUniformLocation(meshProg, u);

  const partProg = program(`
    attribute vec3 aPos; attribute vec2 aUV; attribute vec4 aColor;
    uniform mat4 uMVP;
    varying vec2 vUV; varying vec4 vColor;
    void main() {
      gl_Position = uMVP * vec4(aPos, 1.0);
      vUV = aUV; vColor = aColor;
    }`, `
    precision mediump float;
    varying vec2 vUV; varying vec4 vColor;
    uniform sampler2D uTex; uniform float uHasTex; uniform float uBright;
    void main() {
      vec4 tex = mix(vec4(1.0), texture2D(uTex, vUV), uHasTex);
      gl_FragColor = vec4(tex.rgb * vColor.rgb * uBright, tex.a * vColor.a);
    }`);
  const pLoc = {};
  for (const a of ['aPos', 'aUV', 'aColor']) pLoc[a] = gl.getAttribLocation(partProg, a);
  for (const u of ['uMVP', 'uTex', 'uHasTex', 'uBright']) pLoc[u] = gl.getUniformLocation(partProg, u);
  let brightness = 2; // preview boost — additive spell sprites read dim on a dark bg at 1.0
  // scene background levels: dark / medium / light (grid color derived from bg)
  const BG_LEVELS = [
    { bg: [0.055, 0.062, 0.078], grid: [0.16, 0.18, 0.22] },
    { bg: [0.17, 0.185, 0.21], grid: [0.30, 0.32, 0.36] },
    { bg: [0.36, 0.38, 0.42], grid: [0.52, 0.54, 0.58] },
  ];
  let bgLevel = 0;

  const whiteTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, whiteTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));

  const MAXP = 4000;
  const P_STRIDE = 9;
  const partData = new Float32Array(MAXP * 6 * P_STRIDE);
  const partVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, partVbo);
  gl.bufferData(gl.ARRAY_BUFFER, partData.byteLength, gl.DYNAMIC_DRAW);

  // ---------- math ----------
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  function lookAtZUp(eye, center) {
    const up = [0, 0, 1];
    let z = [eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]];
    const zl = Math.hypot(...z); z = z.map((v) => v / zl);
    let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
    const xl = Math.hypot(...x) || 1; x = x.map((v) => v / xl);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return [
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
      -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
      -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1,
    ];
  }
  const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  // transform {offset, yaw, pitch, roll, scale} -> { mat4 (column-major), R rows, scale }
  function makeTransform(t) {
    if (!t) return null;
    const { offset = [0, 0, 0], yaw = 0, pitch = 0, roll = 0, scale = 1 } = t;
    const cz = Math.cos(yaw), sz = Math.sin(yaw);
    const cy = Math.cos(pitch), sy = Math.sin(pitch);
    const cx = Math.cos(roll), sx = Math.sin(roll);
    const R = [
      [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
      [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
      [-sy, cy * sx, cy * cx],
    ];
    const m = [
      R[0][0] * scale, R[1][0] * scale, R[2][0] * scale, 0,
      R[0][1] * scale, R[1][1] * scale, R[2][1] * scale, 0,
      R[0][2] * scale, R[1][2] * scale, R[2][2] * scale, 0,
      offset[0], offset[1], offset[2], 1,
    ];
    const rotM = [
      R[0][0], R[1][0], R[2][0], 0,
      R[0][1], R[1][1], R[2][1], 0,
      R[0][2], R[1][2], R[2][2], 0,
      0, 0, 0, 1,
    ];
    return { m, rotM, R, scale, offset };
  }
  function xfPoint(T, x, y, z) {
    if (!T) return [x, y, z];
    const s = T.scale;
    x *= s; y *= s; z *= s;
    return [
      T.R[0][0] * x + T.R[0][1] * y + T.R[0][2] * z + T.offset[0],
      T.R[1][0] * x + T.R[1][1] * y + T.R[1][2] * z + T.offset[1],
      T.R[2][0] * x + T.R[2][1] * y + T.R[2][2] * z + T.offset[2],
    ];
  }
  function xfDir(T, x, y, z) {
    if (!T) return [x, y, z];
    return [
      T.R[0][0] * x + T.R[0][1] * y + T.R[0][2] * z,
      T.R[1][0] * x + T.R[1][1] * y + T.R[1][2] * z,
      T.R[2][0] * x + T.R[2][1] * y + T.R[2][2] * z,
    ];
  }

  // grid
  const gridVerts = [];
  for (let i = -5; i <= 5; i++) gridVerts.push(i, -5, 0, i, 5, 0, -5, i, 0, 5, i, 0);
  const gridVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, gridVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gridVerts), gl.STATIC_DRAW);
  const gridCount = gridVerts.length / 3;

  // ---------- translate gizmo (lab mode) ----------
  const gizmoVbo = gl.createBuffer();

  function gizmoOrigin() {
    const T = models[1] && models[1].T;
    return T ? T.offset.slice() : null;
  }
  function gizmoLen() { return dist * 0.22; }

  // world -> canvas pixel coords using last frame's MVP
  function project(p) {
    if (!lastMvp) return null;
    const m = lastMvp;
    const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (cw <= 0.0001) return null;
    const cx = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / cw;
    const cy = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / cw;
    return [(cx * 0.5 + 0.5) * canvas.width, (1 - (cy * 0.5 + 0.5)) * canvas.height];
  }

  // distance from point to segment in 2D, plus info to convert pixel motion to axis motion
  function axisHit(mx, my) {
    const o = gizmoOrigin();
    if (!o) return null;
    const so = project(o);
    if (!so) return null;
    const L = gizmoLen();
    let best = null;
    for (let i = 0; i < 3; i++) {
      const tip = [o[0] + AXIS_DIRS[i][0] * L, o[1] + AXIS_DIRS[i][1] * L, o[2] + AXIS_DIRS[i][2] * L];
      const st = project(tip);
      if (!st) continue;
      const vx = st[0] - so[0], vy = st[1] - so[1];
      const segLen2 = vx * vx + vy * vy;
      if (segLen2 < 4) continue; // axis pointing at camera — unpickable
      let t = ((mx - so[0]) * vx + (my - so[1]) * vy) / segLen2;
      t = Math.max(0, Math.min(1, t));
      const dx = mx - (so[0] + vx * t), dy = my - (so[1] + vy * t);
      const d = Math.hypot(dx, dy);
      if (d < 10 && (!best || d < best.d)) {
        const segLen = Math.sqrt(segLen2);
        best = { axis: i, d, screenDir: [vx / segLen, vy / segLen], worldPerPixel: L / segLen };
      }
    }
    return best;
  }

  function drawGizmo(mvp) {
    const o = gizmoOrigin();
    if (!o) return;
    const L = gizmoLen();
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(meshProg);
    gl.uniformMatrix4fv(mLoc.uMVP, false, new Float32Array(mvp));
    gl.uniformMatrix4fv(mLoc.uModel, false, new Float32Array(IDENT));
    gl.uniform1f(mLoc.uFlat, 1);
    gl.uniform1f(mLoc.uHasTex, 0);
    gl.uniform1f(mLoc.uAlphaTest, 0);
    gl.uniform1f(mLoc.uBright, 1);
    gl.bindTexture(gl.TEXTURE_2D, whiteTex);
    gl.bindBuffer(gl.ARRAY_BUFFER, gizmoVbo);
    gl.enableVertexAttribArray(mLoc.aPos);
    gl.vertexAttribPointer(mLoc.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(mLoc.aNrm);
    gl.vertexAttrib3f(mLoc.aNrm, 0, 0, 1);
    gl.disableVertexAttribArray(mLoc.aUV);
    gl.vertexAttrib2f(mLoc.aUV, 0, 0);
    for (let i = 0; i < 3; i++) {
      const a = AXIS_DIRS[i];
      const p1 = AXIS_DIRS[(i + 1) % 3], p2 = AXIS_DIRS[(i + 2) % 3];
      const tip = [o[0] + a[0] * L, o[1] + a[1] * L, o[2] + a[2] * L];
      const back = 0.16 * L, side = 0.06 * L;
      const hb = [tip[0] - a[0] * back, tip[1] - a[1] * back, tip[2] - a[2] * back];
      const verts = [
        o[0], o[1], o[2], tip[0], tip[1], tip[2],
        tip[0], tip[1], tip[2], hb[0] + p1[0] * side, hb[1] + p1[1] * side, hb[2] + p1[2] * side,
        tip[0], tip[1], tip[2], hb[0] - p1[0] * side, hb[1] - p1[1] * side, hb[2] - p1[2] * side,
        tip[0], tip[1], tip[2], hb[0] + p2[0] * side, hb[1] + p2[1] * side, hb[2] + p2[2] * side,
        tip[0], tip[1], tip[2], hb[0] - p2[0] * side, hb[1] - p2[1] * side, hb[2] - p2[2] * side,
      ];
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
      const c = AXIS_COLORS[i];
      const hot = i === gizmoAxis || (gizmoAxis === -1 && i === hoverAxis);
      gl.uniform3f(mLoc.uColor, hot ? Math.min(1, c[0] + 0.3) : c[0], hot ? Math.min(1, c[1] + 0.3) : c[1], hot ? Math.min(1, c[2] + 0.3) : c[2]);
      gl.drawArrays(gl.LINES, 0, 10);
    }
    gl.enable(gl.DEPTH_TEST);
  }

  function applyBlend(mode) {
    switch (mode) {
      case 0: gl.disable(gl.BLEND); return { alphaTest: 0, depthWrite: true };
      case 1: gl.disable(gl.BLEND); return { alphaTest: 1, depthWrite: true };
      case 3: gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); return { alphaTest: 0, depthWrite: false };
      case 4: gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE); return { alphaTest: 0, depthWrite: false };
      case 5: gl.enable(gl.BLEND); gl.blendFunc(gl.DST_COLOR, gl.ZERO); return { alphaTest: 0, depthWrite: false };
      case 6: gl.enable(gl.BLEND); gl.blendFunc(gl.DST_COLOR, gl.SRC_COLOR); return { alphaTest: 0, depthWrite: false };
      case 2:
      default: gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); return { alphaTest: 0, depthWrite: false };
    }
  }

  // ---------- animation (vanilla M2 single-timeline tracks) ----------

  function quatToMat3(x, y, z, w) {
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    return [
      1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
      2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
      2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
    ]; // row-major 3x3
  }

  // sample a track at global-timeline time t clamped to [start,end]; returns array of dim
  function sampleTrack(track, dim, t, start, end, globalSeqs, nowMs) {
    const times = track.times, values = track.values;
    const n = times.length;
    if (track.gseq >= 0 && track.gseq < globalSeqs.length) {
      const dur = Math.max(1, globalSeqs[track.gseq]);
      t = nowMs % dur;
      start = 0; end = dur;
    }
    // binary search: last key <= t
    let lo = 0, hi = n - 1, k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const read = (i) => values.slice(i * dim, i * dim + dim);
    if (k < 0) {
      // before first key: use first key at/after window start
      for (let i = 0; i < n; i++) if (times[i] >= start) return read(i);
      return read(0);
    }
    if (times[k] < start) {
      // last key belongs to an earlier animation on the shared timeline
      const k2 = k + 1;
      if (k2 < n && times[k2] <= end) return read(k2);
      return read(k);
    }
    const k2 = k + 1;
    if (k2 >= n || times[k2] > end || track.interp === 0) return read(k);
    const span = times[k2] - times[k];
    const f = span > 0 ? (t - times[k]) / span : 0;
    const a = read(k), b = read(k2);
    if (dim === 4) {
      // quaternion nlerp with hemisphere correction
      let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
      const s = dot < 0 ? -1 : 1;
      const out = [
        a[0] + (b[0] * s - a[0]) * f,
        a[1] + (b[1] * s - a[1]) * f,
        a[2] + (b[2] * s - a[2]) * f,
        a[3] + (b[3] * s - a[3]) * f,
      ];
      const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
      return [out[0] / l, out[1] / l, out[2] / l, out[3] / l];
    }
    return a.map((v, i) => v + (b[i] - v) * f);
  }

  // compute per-bone 3x4 world transforms (row-major [r00..r02,tx, r10..,ty, r20..,tz])
  function computePose(md, nowMs, camRight, camUp) {
    const sk = md.skel;
    const seq = sk.sequences[md.animSeq];
    const dur = Math.max(1, seq.end - seq.start);
    const t = seq.start + ((nowMs - md.animT0) % dur);
    const bones = sk.bones;
    const world = md.boneMats; // Float32Array(bones*12)
    const done = md.boneDone;
    done.fill(0);

    const camFwd = [
      camRight[1] * camUp[2] - camRight[2] * camUp[1],
      camRight[2] * camUp[0] - camRight[0] * camUp[2],
      camRight[0] * camUp[1] - camRight[1] * camUp[0],
    ];

    const compute = (bi) => {
      if (done[bi]) return;
      const b = bones[bi];
      if (b.parent >= 0) compute(b.parent);
      const tr = b.trans ? sampleTrack(b.trans, 3, t, seq.start, seq.end, sk.globalSeqs, nowMs) : [0, 0, 0];
      const rq = b.rot ? sampleTrack(b.rot, 4, t, seq.start, seq.end, sk.globalSeqs, nowMs) : null;
      const sc = b.scale ? sampleTrack(b.scale, 3, t, seq.start, seq.end, sk.globalSeqs, nowMs) : [1, 1, 1];
      const R = rq ? quatToMat3(rq[0], rq[1], rq[2], rq[3]) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
      // local = T(pivot + trans) * R * S * T(-pivot)
      const px = b.pivot[0], py = b.pivot[1], pz = b.pivot[2];
      const l = [
        R[0] * sc[0], R[1] * sc[1], R[2] * sc[2], 0,
        R[3] * sc[0], R[4] * sc[1], R[5] * sc[2], 0,
        R[6] * sc[0], R[7] * sc[1], R[8] * sc[2], 0,
      ];
      l[3] = px + tr[0] - (l[0] * px + l[1] * py + l[2] * pz);
      l[7] = py + tr[1] - (l[4] * px + l[5] * py + l[6] * pz);
      l[11] = pz + tr[2] - (l[8] * px + l[9] * py + l[10] * pz);

      const o = bi * 12;
      if (b.parent >= 0) {
        const p = b.parent * 12;
        for (let r = 0; r < 3; r++) {
          const pr = p + r * 4;
          for (let c = 0; c < 3; c++) {
            world[o + r * 4 + c] = world[pr] * l[c] + world[pr + 1] * l[4 + c] + world[pr + 2] * l[8 + c];
          }
          world[o + r * 4 + 3] = world[pr] * l[3] + world[pr + 1] * l[7] + world[pr + 2] * l[11] + world[pr + 3];
        }
      } else {
        world.set(l, o);
      }
      if (b.flags & 0x8) {
        // spherical billboard: replace rotation with camera axes (keep scale magnitude)
        const o2 = bi * 12;
        const sx = Math.hypot(world[o2], world[o2 + 4], world[o2 + 8]) || 1;
        // world position of the pivot stays fixed
        const wx = world[o2] * px + world[o2 + 1] * py + world[o2 + 2] * pz + world[o2 + 3];
        const wy = world[o2 + 4] * px + world[o2 + 5] * py + world[o2 + 6] * pz + world[o2 + 7];
        const wz = world[o2 + 8] * px + world[o2 + 9] * py + world[o2 + 10] * pz + world[o2 + 11];
        const B = [
          -camFwd[0] * sx, camRight[0] * sx, camUp[0] * sx,
          -camFwd[1] * sx, camRight[1] * sx, camUp[1] * sx,
          -camFwd[2] * sx, camRight[2] * sx, camUp[2] * sx,
        ];
        world[o2] = B[0]; world[o2 + 1] = B[1]; world[o2 + 2] = B[2];
        world[o2 + 4] = B[3]; world[o2 + 5] = B[4]; world[o2 + 6] = B[5];
        world[o2 + 8] = B[6]; world[o2 + 9] = B[7]; world[o2 + 10] = B[8];
        world[o2 + 3] = wx - (B[0] * px + B[1] * py + B[2] * pz);
        world[o2 + 7] = wy - (B[3] * px + B[4] * py + B[5] * pz);
        world[o2 + 11] = wz - (B[6] * px + B[7] * py + B[8] * pz);
      }
      done[bi] = 1;
    };
    for (let i = 0; i < bones.length; i++) compute(i);
  }

  function skinModel(md) {
    const { basePos, baseNrm, weights, bIndices } = md.skin;
    const world = md.boneMats;
    const out = md.skin.outPos, outN = md.skin.outNrm;
    const nv = basePos.length / 3;
    for (let v = 0; v < nv; v++) {
      const p0 = basePos[v * 3], p1 = basePos[v * 3 + 1], p2 = basePos[v * 3 + 2];
      const n0 = baseNrm[v * 3], n1 = baseNrm[v * 3 + 1], n2 = baseNrm[v * 3 + 2];
      let x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0, wsum = 0;
      for (let k = 0; k < 4; k++) {
        const w = weights[v * 4 + k];
        if (w === 0) continue;
        wsum += w;
        const o = bIndices[v * 4 + k] * 12;
        x += w * (world[o] * p0 + world[o + 1] * p1 + world[o + 2] * p2 + world[o + 3]);
        y += w * (world[o + 4] * p0 + world[o + 5] * p1 + world[o + 6] * p2 + world[o + 7]);
        z += w * (world[o + 8] * p0 + world[o + 9] * p1 + world[o + 10] * p2 + world[o + 11]);
        nx += w * (world[o] * n0 + world[o + 1] * n1 + world[o + 2] * n2);
        ny += w * (world[o + 4] * n0 + world[o + 5] * n1 + world[o + 6] * n2);
        nz += w * (world[o + 8] * n0 + world[o + 9] * n1 + world[o + 10] * n2);
      }
      if (wsum === 0) { x = p0; y = p1; z = p2; nx = n0; ny = n1; nz = n2; }
      out[v * 3] = x; out[v * 3 + 1] = y; out[v * 3 + 2] = z;
      outN[v * 3] = nx; outN[v * 3 + 1] = ny; outN[v * 3 + 2] = nz;
    }
  }

  // ---------- scene setup ----------
  function buildModel(item) {
    const geom = item.geom;
    const textures = (geom.textures || []).map(() => null);
    let mesh = null;
    let bounds = null;

    if (geom.positions && geom.positions.length) {
      const pos = new Float32Array(geom.positions);
      let nrm = new Float32Array(geom.normals);
      let zeroN = true;
      for (let i = 0; i < Math.min(nrm.length, 30); i++) if (nrm[i] !== 0) { zeroN = false; break; }
      if (zeroN) nrm = pos;
      const uv = new Float32Array(geom.uvs.length ? geom.uvs : new Array((pos.length / 3) * 2).fill(0));
      const idx = new Uint16Array(geom.indices);

      let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
      for (let i = 0; i < pos.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          if (pos[i + a] < min[a]) min[a] = pos[i + a];
          if (pos[i + a] > max[a]) max[a] = pos[i + a];
        }
      }
      bounds = { min, max };

      const mkBuf = (target, data) => {
        const b = gl.createBuffer();
        gl.bindBuffer(target, b);
        gl.bufferData(target, data, gl.STATIC_DRAW);
        return b;
      };
      const wIdx = new Uint16Array(idx.length * 2);
      for (let i = 0; i < idx.length; i += 3) {
        wIdx.set([idx[i], idx[i + 1], idx[i + 1], idx[i + 2], idx[i + 2], idx[i]], i * 2);
      }
      let batches = (geom.batches && geom.batches.length ? geom.batches : [
        { indexStart: 0, indexCount: idx.length, texture: -1, blend: 0, unlit: false, twoSided: true },
      ]).slice();
      batches.sort((a, b) => (a.blend >= 2 ? 1 : 0) - (b.blend >= 2 ? 1 : 0));
      mesh = {
        vbo: mkBuf(gl.ARRAY_BUFFER, pos),
        nbo: mkBuf(gl.ARRAY_BUFFER, nrm),
        ubo: mkBuf(gl.ARRAY_BUFFER, uv),
        ibo: mkBuf(gl.ELEMENT_ARRAY_BUFFER, idx),
        wibo: mkBuf(gl.ELEMENT_ARRAY_BUFFER, wIdx),
        count: idx.length, wcount: wIdx.length, batches,
      };
    }

    const emitters = item.noParticles ? [] : (geom.particles || []).map((def) => ({
      def,
      rate: Math.min(500, def.emissionRate || 12),
      pool: [],
      acc: 0,
      cap: Math.min(1200, Math.ceil(Math.min(500, def.emissionRate || 12) * def.lifespan * 1.4) + 8),
    }));

    const md = {
      mesh, textures, emitters, bounds,
      gray: !!item.gray,
      visible: item.visible !== false,
      T: makeTransform(item.transform),
      rawTransform: item.transform || null,
      skel: null, animSeq: -1, animT0: 0,
      follow: item.follow || null, // { host: modelIdx, bone, pos, yaw } — track a host bone
      poseValid: false,
    };

    // skeleton + skinning setup
    if (mesh && geom.skeleton && geom.boneWeights && geom.boneIndices &&
        geom.skeleton.sequences.length && geom.skeleton.bones.length) {
      md.skel = geom.skeleton;
      md.boneMats = new Float32Array(md.skel.bones.length * 12);
      md.boneDone = new Uint8Array(md.skel.bones.length);
      md.skin = {
        basePos: new Float32Array(geom.positions),
        baseNrm: new Float32Array(geom.normals),
        weights: new Float32Array(geom.boneWeights),
        bIndices: new Uint8Array(geom.boneIndices),
        outPos: new Float32Array(geom.positions.length),
        outNrm: new Float32Array(geom.normals.length),
      };
      // default: play the id-0 sequence (Stand for characters, the effect loop
      // for spell models) unless the caller opted out
      if (item.animate !== false) {
        const idx = md.skel.sequences.findIndex((s) => s.id === 0 && s.end > s.start);
        md.animSeq = idx >= 0 ? idx : 0;
        md.animT0 = performance.now();
      }
    }
    return md;
  }

  function reframe() {
    let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
    let any = false;
    for (const md of models) {
      if (md.bounds) {
        any = true;
        for (let c = 0; c < 8; c++) {
          const p = xfPoint(md.T,
            c & 1 ? md.bounds.max[0] : md.bounds.min[0],
            c & 2 ? md.bounds.max[1] : md.bounds.min[1],
            c & 4 ? md.bounds.max[2] : md.bounds.min[2]);
          for (let a = 0; a < 3; a++) {
            if (p[a] < min[a]) min[a] = p[a];
            if (p[a] > max[a]) max[a] = p[a];
          }
        }
      } else if (md.emitters.length) {
        any = true;
        for (const e of md.emitters) {
          const d = e.def;
          const r = Math.max(0.4,
            Math.hypot(...d.pos) + Math.abs(d.areaWidth) + Math.abs(d.areaLength),
            d.emissionSpeed * d.lifespan * 0.6,
            Math.max(...d.scales.map(Math.abs)));
          const c0 = xfPoint(md.T, d.pos[0], d.pos[1], d.pos[2]);
          for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], c0[a] - r);
            max[a] = Math.max(max[a], c0[a] + r);
          }
        }
      }
    }
    if (!any) { sceneCenter = [0, 0, 0.5]; sceneRadius = 1; return; }
    sceneCenter = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    sceneRadius = Math.min(30, Math.max(0.3, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2));
  }

  function showComposite(items) {
    clear();
    models = items.map(buildModel);
    reframe();
    dist = sceneRadius * 2.6;
    pan = [0, 0, 0];
  }
  function show(geom) { showComposite([{ geom }]); }

  function setModelTexture(mi, i, width, height, rgba) {
    const md = models[mi];
    if (!md || i < 0 || i >= md.textures.length) return;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const pot = (width & (width - 1)) === 0 && (height & (height - 1)) === 0;
    if (pot) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    md.textures[i] = tex;
  }

  function setTransform(mi, transform, opts = {}) {
    const md = models[mi];
    if (!md) return;
    md.T = makeTransform(transform);
    md.rawTransform = transform;
    // keepParticles leaves already-spawned particles in world space (moving
    // emitters leave natural trails, e.g. missiles in flight)
    if (!opts.keepParticles) {
      for (const e of md.emitters) e.pool.length = 0;
      reframe();
    }
  }

  function setVisible(mi, v) {
    const md = models[mi];
    if (!md) return;
    md.visible = !!v;
    if (!v) for (const e of md.emitters) { e.pool.length = 0; e.acc = 0; }
  }

  function clear() {
    for (const md of models) {
      if (md.mesh) for (const b of [md.mesh.vbo, md.mesh.nbo, md.mesh.ubo, md.mesh.ibo, md.mesh.wibo]) gl.deleteBuffer(b);
      for (const t of md.textures) if (t) gl.deleteTexture(t);
    }
    models = [];
  }

  // ---------- particles ----------
  const rand = Math.random;
  const randc = () => Math.random() - 0.5;

  function spawn(def, T) {
    let px = 0, py = 0, pz = 0, dx = 0, dy = 0, dz = 1;
    if (def.emitterType === 2) {
      const rMin = Math.min(Math.abs(def.areaLength), Math.abs(def.areaWidth));
      const rMax = Math.max(Math.abs(def.areaLength), Math.abs(def.areaWidth));
      const r = rMin + rand() * (rMax - rMin);
      const az = rand() * (def.horizontalRange || Math.PI * 2);
      const el = randc() * 2 * def.verticalRange;
      px = r * Math.cos(el) * Math.cos(az);
      py = r * Math.cos(el) * Math.sin(az);
      pz = r * Math.sin(el);
      const l = Math.hypot(px, py, pz);
      if (l > 1e-4) { dx = px / l; dy = py / l; dz = pz / l; }
    } else {
      px = randc() * Math.abs(def.areaLength);
      py = randc() * Math.abs(def.areaWidth);
      pz = 0;
      const polar = rand() * def.verticalRange;
      const az = def.horizontalRange > 0 ? randc() * 2 * def.horizontalRange : rand() * Math.PI * 2;
      dx = Math.sin(polar) * Math.cos(az);
      dy = Math.sin(polar) * Math.sin(az);
      dz = Math.cos(polar);
    }
    if (def.zSource > 0) {
      const sx = px, sy = py, sz = pz - def.zSource;
      const l = Math.hypot(sx, sy, sz);
      if (l > 1e-4) { dx = sx / l; dy = sy / l; dz = sz / l; }
    }
    const speed = def.emissionSpeed * (1 + randc() * 2 * def.speedVariation) * (T ? T.scale : 1);
    const wp = xfPoint(T, def.pos[0] + px, def.pos[1] + py, def.pos[2] + pz);
    const wd = xfDir(T, dx, dy, dz);
    return {
      x: wp[0], y: wp[1], z: wp[2],
      vx: wd[0] * speed, vy: wd[1] * speed, vz: wd[2] * speed,
      age: 0,
      life: def.lifespan * (0.75 + rand() * 0.5),
      phase: randc() * Math.PI * 2 * (def.spin || 0),
      sizeScale: T ? T.scale : 1,
    };
  }

  function lerp3(t, mid, a, b, c) {
    if (t <= mid) { const k = mid > 0 ? t / mid : 1; return a + (b - a) * k; }
    const k = mid < 1 ? (t - mid) / (1 - mid) : 1;
    return b + (c - b) * k;
  }

  function simulate(dt) {
    let total = 0;
    for (const md of models) for (const e of md.emitters) total += e.pool.length;
    for (const md of models) {
      for (const e of md.emitters) {
        const d = e.def;
        for (let i = e.pool.length - 1; i >= 0; i--) {
          const p = e.pool[i];
          p.age += dt;
          if (p.age >= p.life) { e.pool.splice(i, 1); total--; continue; }
          p.vz -= d.gravity * p.sizeScale * dt;
          p.vx += d.windVector[0] * dt; p.vy += d.windVector[1] * dt; p.vz += d.windVector[2] * dt;
          if (d.drag > 0) {
            const f = Math.exp(-d.drag * dt);
            p.vx *= f; p.vy *= f; p.vz *= f;
          }
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        }
        if (md.visible) {
          e.acc += e.rate * dt;
          while (e.acc >= 1 && e.pool.length < e.cap && total < MAXP) {
            e.acc -= 1;
            e.pool.push(spawn(d, md.T));
            total++;
          }
        }
        if (e.acc > 4) e.acc = 4;
      }
    }
  }

  function fillParticles(e, right, up, base) {
    const d = e.def;
    const cells = d.rows * d.columns;
    let n = 0;
    for (const p of e.pool) {
      if (base + n >= MAXP) break;
      const t = Math.min(1, p.age / p.life);
      const scale = lerp3(t, d.midPoint, d.scales[0], d.scales[1], d.scales[2]) * p.sizeScale;
      if (scale <= 0) continue;
      const half = scale / 2;
      const cr = lerp3(t, d.midPoint, d.colors[0][0], d.colors[1][0], d.colors[2][0]) / 255;
      const cg = lerp3(t, d.midPoint, d.colors[0][1], d.colors[1][1], d.colors[2][1]) / 255;
      const cb = lerp3(t, d.midPoint, d.colors[0][2], d.colors[1][2], d.colors[2][2]) / 255;
      const ca = lerp3(t, d.midPoint, d.colors[0][3], d.colors[1][3], d.colors[2][3]) / 255;
      let u0 = 0, v0 = 0, u1 = 1, v1 = 1;
      if (cells > 1) {
        let cell;
        if (t < 0.5) cell = d.lifespanUVAnim[0] + (d.lifespanUVAnim[2] - d.lifespanUVAnim[0]) * (t * 2);
        else cell = d.decayUVAnim[0] + (d.decayUVAnim[2] - d.decayUVAnim[0]) * ((t - 0.5) * 2);
        cell = Math.floor(Math.abs(cell)) % cells;
        const col = cell % d.columns, row = Math.floor(cell / d.columns) % d.rows;
        u0 = col / d.columns; u1 = (col + 1) / d.columns;
        v0 = row / d.rows; v1 = (row + 1) / d.rows;
      }
      const ang = p.phase + (d.spin || 0) * Math.PI * 2 * t;
      const ca2 = Math.cos(ang), sa2 = Math.sin(ang);
      const rx = (right[0] * ca2 + up[0] * sa2) * half, ry = (right[1] * ca2 + up[1] * sa2) * half, rz = (right[2] * ca2 + up[2] * sa2) * half;
      const ux = (up[0] * ca2 - right[0] * sa2) * half, uy = (up[1] * ca2 - right[1] * sa2) * half, uz = (up[2] * ca2 - right[2] * sa2) * half;
      const corners = [
        [p.x - rx - ux, p.y - ry - uy, p.z - rz - uz, u0, v1],
        [p.x + rx - ux, p.y + ry - uy, p.z + rz - uz, u1, v1],
        [p.x + rx + ux, p.y + ry + uy, p.z + rz + uz, u1, v0],
        [p.x - rx - ux, p.y - ry - uy, p.z - rz - uz, u0, v1],
        [p.x + rx + ux, p.y + ry + uy, p.z + rz + uz, u1, v0],
        [p.x - rx + ux, p.y - ry + uy, p.z - rz + uz, u0, v0],
      ];
      let o = (base + n) * 6 * P_STRIDE;
      for (const c of corners) {
        partData[o] = c[0]; partData[o + 1] = c[1]; partData[o + 2] = c[2];
        partData[o + 3] = c[3]; partData[o + 4] = c[4];
        partData[o + 5] = cr; partData[o + 6] = cg; partData[o + 7] = cb; partData[o + 8] = ca;
        o += P_STRIDE;
      }
      n++;
    }
    return n;
  }

  // ---------- render loop ----------
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function drawMesh(md, mvp) {
    const mesh = md.mesh;
    const mvpM = md.T ? mul(mvp, md.T.m) : mvp;
    gl.uniformMatrix4fv(mLoc.uMVP, false, new Float32Array(mvpM));
    gl.uniformMatrix4fv(mLoc.uModel, false, new Float32Array(md.T ? md.T.rotM : IDENT));
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
    gl.enableVertexAttribArray(mLoc.aPos);
    gl.vertexAttribPointer(mLoc.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nbo);
    gl.enableVertexAttribArray(mLoc.aNrm);
    gl.vertexAttribPointer(mLoc.aNrm, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.ubo);
    gl.enableVertexAttribArray(mLoc.aUV);
    gl.vertexAttribPointer(mLoc.aUV, 2, gl.FLOAT, false, 0, 0);
    if (wireframe) {
      gl.uniform3f(mLoc.uColor, 0.42, 0.7, 0.88);
      gl.uniform1f(mLoc.uFlat, 1);
      gl.uniform1f(mLoc.uHasTex, 0);
      gl.uniform1f(mLoc.uAlphaTest, 0);
      gl.uniform1f(mLoc.uBright, 1);
      gl.disable(gl.BLEND);
      gl.bindTexture(gl.TEXTURE_2D, whiteTex);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.wibo);
      gl.drawElements(gl.LINES, mesh.wcount, gl.UNSIGNED_SHORT, 0);
      return;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
    for (const b of mesh.batches) {
      const tex = !md.gray && b.texture >= 0 ? md.textures[b.texture] : null;
      gl.bindTexture(gl.TEXTURE_2D, tex || whiteTex);
      gl.uniform1f(mLoc.uHasTex, tex ? 1 : 0);
      gl.uniform1f(mLoc.uBright, md.gray ? 1 : brightness);
      if (md.gray) gl.uniform3f(mLoc.uColor, 0.68, 0.70, 0.74);
      else gl.uniform3f(mLoc.uColor, tex ? 1 : 0.78, tex ? 1 : 0.81, tex ? 1 : 0.88);
      gl.uniform1f(mLoc.uFlat, !md.gray && b.unlit ? 1 : 0);
      const st = md.gray ? applyBlend(0) : applyBlend(b.blend);
      gl.uniform1f(mLoc.uAlphaTest, st.alphaTest);
      gl.depthMask(st.depthWrite);
      gl.drawElements(gl.TRIANGLES, b.indexCount, gl.UNSIGNED_SHORT, b.indexStart * 2);
    }
    gl.depthMask(true);
  }

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
    lastT = now;
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    const bg = BG_LEVELS[bgLevel].bg;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);

    if (spin && !dragging) yaw += 0.004;
    const c = [sceneCenter[0] + pan[0], sceneCenter[1] + pan[1], sceneCenter[2] + pan[2]];
    const d = models.length ? dist : 6;
    const eye = [
      c[0] + d * Math.cos(pitch) * Math.cos(yaw),
      c[1] + d * Math.cos(pitch) * Math.sin(yaw),
      c[2] + d * Math.sin(pitch),
    ];
    const view = lookAtZUp(eye, c);
    const proj = perspective(0.9, canvas.width / Math.max(1, canvas.height), 0.05, 500);
    const mvp = mul(proj, view);
    const right = [view[0], view[4], view[8]];
    const up = [view[1], view[5], view[9]];
    lastMvp = mvp;
    lastRight = right;
    lastUp = up;

    // grid
    gl.useProgram(meshProg);
    gl.uniform1i(mLoc.uTex, 0);
    const gs = Math.max(models.length ? sceneRadius : 1, 0.5);
    const gridMvp = mul(mvp, [gs, 0, 0, 0, 0, gs, 0, 0, 0, 0, gs, 0, c[0], c[1], 0, 1]);
    gl.uniformMatrix4fv(mLoc.uMVP, false, new Float32Array(gridMvp));
    gl.uniformMatrix4fv(mLoc.uModel, false, new Float32Array(IDENT));
    const gc = BG_LEVELS[bgLevel].grid;
    gl.uniform3f(mLoc.uColor, gc[0], gc[1], gc[2]);
    gl.uniform1f(mLoc.uBright, 1);
    gl.uniform1f(mLoc.uFlat, 1);
    gl.uniform1f(mLoc.uHasTex, 0);
    gl.uniform1f(mLoc.uAlphaTest, 0);
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, whiteTex);
    gl.bindBuffer(gl.ARRAY_BUFFER, gridVbo);
    gl.enableVertexAttribArray(mLoc.aPos);
    gl.vertexAttribPointer(mLoc.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(mLoc.aNrm);
    gl.vertexAttrib3f(mLoc.aNrm, 0, 0, 1);
    gl.disableVertexAttribArray(mLoc.aUV);
    gl.vertexAttrib2f(mLoc.aUV, 0, 0);
    gl.drawArrays(gl.LINES, 0, gridCount);

    // animate + skin
    for (const md of models) {
      if (!md.mesh || !md.skel || md.animSeq < 0 || !md.visible) continue;
      // billboard axes must live in model space: undo the model transform's rotation
      let br = right, bu = up;
      if (md.T) {
        const R = md.T.R; // transpose = inverse for pure rotation
        br = [R[0][0] * right[0] + R[1][0] * right[1] + R[2][0] * right[2],
              R[0][1] * right[0] + R[1][1] * right[1] + R[2][1] * right[2],
              R[0][2] * right[0] + R[1][2] * right[1] + R[2][2] * right[2]];
        bu = [R[0][0] * up[0] + R[1][0] * up[1] + R[2][0] * up[2],
              R[0][1] * up[0] + R[1][1] * up[1] + R[2][1] * up[2],
              R[0][2] * up[0] + R[1][2] * up[1] + R[2][2] * up[2]];
      }
      computePose(md, now, br, bu);
      md.poseValid = true;
      skinModel(md);
      gl.bindBuffer(gl.ARRAY_BUFFER, md.mesh.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, md.skin.outPos);
      gl.bindBuffer(gl.ARRAY_BUFFER, md.mesh.nbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, md.skin.outNrm);
    }

    // bone-followers: re-anchor to the host's animated attachment bone so
    // effects ride the hands/chest through the animation
    for (const md of models) {
      if (!md.follow) continue;
      const host = models[md.follow.host];
      if (!host) continue;
      const f = md.follow;
      let p = f.pos;
      if (host.poseValid && host.skel && f.bone >= 0 && f.bone < host.skel.bones.length) {
        const W = host.boneMats, o = f.bone * 12;
        p = [
          W[o] * f.pos[0] + W[o + 1] * f.pos[1] + W[o + 2] * f.pos[2] + W[o + 3],
          W[o + 4] * f.pos[0] + W[o + 5] * f.pos[1] + W[o + 6] * f.pos[2] + W[o + 7],
          W[o + 8] * f.pos[0] + W[o + 9] * f.pos[1] + W[o + 10] * f.pos[2] + W[o + 11],
        ];
      }
      const world = xfPoint(host.T, p[0], p[1], p[2]);
      md.T = makeTransform({ offset: world, yaw: f.yaw || 0, scale: f.scale || 1 });
    }

    for (const md of models) if (md.mesh && md.visible) drawMesh(md, mvp);

    // particles across all models
    if (particlesOn && models.some((m) => m.emitters.length)) {
      simulate(dt);
      gl.useProgram(partProg);
      gl.uniform1i(pLoc.uTex, 0);
      gl.uniform1f(pLoc.uBright, brightness);
      gl.uniformMatrix4fv(pLoc.uMVP, false, new Float32Array(mvp));
      gl.depthMask(false);
      let base = 0;
      const draws = [];
      for (const md of models) {
        for (const e of md.emitters) {
          const n = fillParticles(e, right, up, base);
          if (n > 0) draws.push({ md, e, base, n });
          base += n;
        }
      }
      if (base > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, partVbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, partData.subarray(0, base * 6 * P_STRIDE));
        gl.enableVertexAttribArray(pLoc.aPos);
        gl.vertexAttribPointer(pLoc.aPos, 3, gl.FLOAT, false, P_STRIDE * 4, 0);
        gl.enableVertexAttribArray(pLoc.aUV);
        gl.vertexAttribPointer(pLoc.aUV, 2, gl.FLOAT, false, P_STRIDE * 4, 12);
        gl.enableVertexAttribArray(pLoc.aColor);
        gl.vertexAttribPointer(pLoc.aColor, 4, gl.FLOAT, false, P_STRIDE * 4, 20);
        for (const dr of draws) {
          const texIdx = dr.e.def.texture;
          const tex = texIdx >= 0 ? dr.md.textures[texIdx] : null;
          gl.bindTexture(gl.TEXTURE_2D, tex || whiteTex);
          gl.uniform1f(pLoc.uHasTex, tex ? 1 : 0);
          applyBlend(dr.e.def.blendingType);
          gl.drawArrays(gl.TRIANGLES, dr.base * 6, dr.n * 6);
        }
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    if (labDragCb) drawGizmo(mvp);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame((t) => { lastT = t; requestAnimationFrame(frame); });

  function canvasXY(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  canvas.addEventListener('mousedown', (e) => {
    lastX = e.clientX; lastY = e.clientY;
    // right/middle button pans the camera (lab and storyboard modes)
    if ((labDragCb || panEnabled) && (e.button === 1 || e.button === 2)) {
      e.preventDefault();
      panning = true;
      return;
    }
    if (e.button !== 0) return;
    dragging = true;
    if (labDragCb && !e.shiftKey) {
      const [mx, my] = canvasXY(e);
      const hit = axisHit(mx, my);
      if (hit) {
        gizmoAxis = hit.axis;
        gizmoDrag = hit;
        return;
      }
    }
    labDragging = !!(labDragCb && e.shiftKey);
  });
  canvas.addEventListener('contextmenu', (e) => { if (labDragCb || panEnabled) e.preventDefault(); });
  window.addEventListener('mouseup', () => {
    dragging = false; labDragging = false; panning = false;
    gizmoAxis = -1; gizmoDrag = null;
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging && !panning) {
      // hover highlight for gizmo arrows
      if (labDragCb && lastMvp) {
        const [mx, my] = canvasXY(e);
        const hit = axisHit(mx, my);
        const ax = hit ? hit.axis : -1;
        if (ax !== hoverAxis) hoverAxis = ax;
        canvas.style.cursor = ax >= 0 ? 'grab' : '';
      }
      return;
    }
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (panning) {
      const k = dist / 600;
      pan[0] -= (lastRight[0] * dx - lastUp[0] * dy) * k;
      pan[1] -= (lastRight[1] * dx - lastUp[1] * dy) * k;
      pan[2] -= (lastRight[2] * dx - lastUp[2] * dy) * k;
      return;
    }
    if (gizmoAxis >= 0 && gizmoDrag && labDragCb) {
      // constrain motion to the picked axis
      const along = dx * gizmoDrag.screenDir[0] + dy * gizmoDrag.screenDir[1];
      const w = along * gizmoDrag.worldPerPixel;
      const a = AXIS_DIRS[gizmoAxis];
      labDragCb([a[0] * w, a[1] * w, a[2] * w]);
      return;
    }
    if (labDragging && labDragCb) {
      // free move in the camera plane, scaled by view distance
      const k = dist / 600;
      const right = [-Math.sin(yaw), Math.cos(yaw), 0];
      labDragCb([
        right[0] * dx * k,
        right[1] * dx * k,
        -dy * k,
      ]);
      return;
    }
    yaw -= dx * 0.008;
    pitch = Math.min(1.5, Math.max(-1.5, pitch + dy * 0.008));
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    dist *= e.deltaY > 0 ? 1.12 : 0.89;
    dist = Math.max(0.2, Math.min(300, dist));
  }, { passive: false });

  return {
    show, showComposite, clear,
    setTexture: (i, w, h, rgba) => setModelTexture(0, i, w, h, rgba),
    setModelTexture, setTransform, setVisible,
    setPanEnabled: (b) => {
      panEnabled = !!b;
      if (!b && !labDragCb) pan = [0, 0, 0];
    },
    setLabDrag: (cb) => {
      labDragCb = cb;
      if (!cb) {
        pan = [0, 0, 0];
        hoverAxis = -1; gizmoAxis = -1; gizmoDrag = null;
        canvas.style.cursor = '';
      }
    },
    setWireframe: (b) => { wireframe = b; },
    setSpin: (b) => { spin = b; },
    setParticles: (b) => { particlesOn = b; },
    setBrightness: (v) => { brightness = Math.max(0.25, Math.min(4, Number(v) || 1)); },
    setBackground: (i) => { bgLevel = Math.max(0, Math.min(BG_LEVELS.length - 1, i | 0)); },
    backgroundLevels: 3,
    // seqIndex into geom.skeleton.sequences, or -1 for bind pose
    setAnimation: (mi, seqIndex) => {
      const md = models[mi];
      if (!md || !md.skel) return;
      if (seqIndex < 0 || seqIndex >= md.skel.sequences.length) {
        md.animSeq = -1;
        // restore bind pose geometry
        if (md.skin && md.mesh) {
          gl.bindBuffer(gl.ARRAY_BUFFER, md.mesh.vbo);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, md.skin.basePos);
          gl.bindBuffer(gl.ARRAY_BUFFER, md.mesh.nbo);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, md.skin.baseNrm);
        }
        return;
      }
      md.animSeq = seqIndex;
      md.animT0 = performance.now();
    },
    getAnimation: (mi) => (models[mi] && models[mi].skel ? models[mi].animSeq : -1),
  };
})();
