// WebGL model viewer for M2 geometry (Z-up) with BLP textures and a CPU
// particle-emitter simulation. No dependencies.
// API: Viewer.show(geom), Viewer.setTexture(i, w, h, rgba), Viewer.clear(),
//      Viewer.setWireframe(b), Viewer.setSpin(b), Viewer.setParticles(b)
const Viewer = (() => {
  const canvas = document.getElementById('gl');
  const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
  if (!gl) {
    return { show() {}, clear() {}, setTexture() {}, setWireframe() {}, setSpin() {}, setParticles() {} };
  }
  let mesh = null;            // geometry + batches
  let model = null;           // { textures: [], emitters: [], center, radius }
  let wireframe = false, spin = true, particlesOn = true;
  let yaw = 0.6, pitch = 0.35, dist = 3;
  let dragging = false, lastX = 0, lastY = 0;
  let lastT = 0;

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
    uniform float uAlphaTest; uniform sampler2D uTex;
    void main() {
      vec3 n = normalize(vNrm);
      float d1 = max(dot(n, normalize(vec3(0.5, 0.6, 0.8))), 0.0);
      float d2 = max(dot(n, normalize(vec3(-0.6, -0.3, 0.4))), 0.0) * 0.35;
      float l = mix(0.25 + 0.75 * d1 + d2, 1.0, uFlat);
      vec4 tex = mix(vec4(1.0), texture2D(uTex, vUV), uHasTex);
      if (uAlphaTest > 0.5 && tex.a < 0.5) discard;
      gl_FragColor = vec4(uColor * l * tex.rgb, tex.a);
    }`);
  const mLoc = {
    aPos: gl.getAttribLocation(meshProg, 'aPos'),
    aNrm: gl.getAttribLocation(meshProg, 'aNrm'),
    aUV: gl.getAttribLocation(meshProg, 'aUV'),
    uMVP: gl.getUniformLocation(meshProg, 'uMVP'),
    uModel: gl.getUniformLocation(meshProg, 'uModel'),
    uColor: gl.getUniformLocation(meshProg, 'uColor'),
    uFlat: gl.getUniformLocation(meshProg, 'uFlat'),
    uHasTex: gl.getUniformLocation(meshProg, 'uHasTex'),
    uAlphaTest: gl.getUniformLocation(meshProg, 'uAlphaTest'),
    uTex: gl.getUniformLocation(meshProg, 'uTex'),
  };

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
    uniform sampler2D uTex; uniform float uHasTex;
    void main() {
      vec4 tex = mix(vec4(1.0), texture2D(uTex, vUV), uHasTex);
      gl_FragColor = tex * vColor;
    }`);
  const pLoc = {
    aPos: gl.getAttribLocation(partProg, 'aPos'),
    aUV: gl.getAttribLocation(partProg, 'aUV'),
    aColor: gl.getAttribLocation(partProg, 'aColor'),
    uMVP: gl.getUniformLocation(partProg, 'uMVP'),
    uTex: gl.getUniformLocation(partProg, 'uTex'),
    uHasTex: gl.getUniformLocation(partProg, 'uHasTex'),
  };

  const whiteTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, whiteTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));

  // particle vertex pool: 6 verts per particle, 9 floats per vert (pos3 uv2 color4)
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

  // grid
  const gridVerts = [];
  for (let i = -5; i <= 5; i++) gridVerts.push(i, -5, 0, i, 5, 0, -5, i, 0, 5, i, 0);
  const gridVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, gridVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gridVerts), gl.STATIC_DRAW);
  const gridCount = gridVerts.length / 3;

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

  // ---------- model setup ----------
  function show(geom) {
    clear();
    const textures = (geom.textures || []).map(() => null);
    let center = [0, 0, 0.5], radius = 1;

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
      center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      radius = Math.max(0.01, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);

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

    // emitters
    const emitters = (geom.particles || []).map((def) => ({
      def,
      // preview fallback: event-driven emitters have rate 0 — give them a gentle idle rate
      rate: Math.min(500, def.emissionRate || 12),
      pool: [],
      acc: 0,
      cap: Math.min(1200, Math.ceil(Math.min(500, def.emissionRate || 12) * def.lifespan * 1.4) + 8),
    }));

    if (!mesh && emitters.length) {
      // frame the particle cloud: emitter positions + travel distance + area
      let r = 0.4;
      for (const e of emitters) {
        const d = e.def;
        r = Math.max(r,
          Math.hypot(...d.pos) + Math.abs(d.areaWidth) + Math.abs(d.areaLength),
          d.emissionSpeed * d.lifespan * 0.6,
          Math.max(...d.scales.map(Math.abs)));
      }
      radius = Math.min(r, 30);
      center = [0, 0, radius * 0.3];
    }

    model = { textures, emitters, center, radius };
    dist = radius * 2.6;
  }

  function setTexture(i, width, height, rgba) {
    if (!model || i < 0 || i >= model.textures.length) return;
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
    model.textures[i] = tex;
  }

  function clear() {
    if (mesh) {
      for (const b of [mesh.vbo, mesh.nbo, mesh.ubo, mesh.ibo, mesh.wibo]) gl.deleteBuffer(b);
      mesh = null;
    }
    if (model) {
      for (const t of model.textures) if (t) gl.deleteTexture(t);
      model = null;
    }
  }

  // ---------- particle simulation ----------
  const rand = Math.random;
  const randc = () => Math.random() - 0.5;

  function spawn(def) {
    let px = 0, py = 0, pz = 0, dx = 0, dy = 0, dz = 1;
    if (def.emitterType === 2) {
      // sphere: radius in [areaLength(min), areaWidth(max)], elevation within verticalRange
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
      // plane (also used for spline/bone fallback): rectangle in xy, cone up
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
    const speed = def.emissionSpeed * (1 + randc() * 2 * def.speedVariation);
    return {
      x: def.pos[0] + px, y: def.pos[1] + py, z: def.pos[2] + pz,
      vx: dx * speed, vy: dy * speed, vz: dz * speed,
      age: 0,
      life: def.lifespan * (0.75 + rand() * 0.5),
      phase: randc() * Math.PI * 2 * (def.spin || 0),
      seed: rand(),
    };
  }

  function lerp3(t, mid, a, b, c) {
    if (t <= mid) { const k = mid > 0 ? t / mid : 1; return a + (b - a) * k; }
    const k = mid < 1 ? (t - mid) / (1 - mid) : 1;
    return b + (c - b) * k;
  }

  function simulate(dt) {
    if (!model) return;
    let total = 0;
    for (const e of model.emitters) total += e.pool.length;
    for (const e of model.emitters) {
      const d = e.def;
      // update
      for (let i = e.pool.length - 1; i >= 0; i--) {
        const p = e.pool[i];
        p.age += dt;
        if (p.age >= p.life) { e.pool.splice(i, 1); total--; continue; }
        p.vz -= d.gravity * dt;
        p.vx += d.windVector[0] * dt; p.vy += d.windVector[1] * dt; p.vz += d.windVector[2] * dt;
        if (d.drag > 0) {
          const f = Math.exp(-d.drag * dt);
          p.vx *= f; p.vy *= f; p.vz *= f;
        }
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      }
      // emit
      e.acc += e.rate * dt;
      while (e.acc >= 1 && e.pool.length < e.cap && total < MAXP) {
        e.acc -= 1;
        e.pool.push(spawn(d));
        total++;
      }
      if (e.acc > 4) e.acc = 4;
    }
  }

  // fill the vertex pool for one emitter; returns number of particles written
  function fillParticles(e, right, up, base) {
    const d = e.def;
    const cells = d.rows * d.columns;
    let n = 0;
    for (const p of e.pool) {
      if (base + n >= MAXP) break;
      const t = Math.min(1, p.age / p.life);
      const scale = lerp3(t, d.midPoint, d.scales[0], d.scales[1], d.scales[2]);
      if (scale <= 0) continue;
      const half = scale / 2;
      const cr = lerp3(t, d.midPoint, d.colors[0][0], d.colors[1][0], d.colors[2][0]) / 255;
      const cg = lerp3(t, d.midPoint, d.colors[0][1], d.colors[1][1], d.colors[2][1]) / 255;
      const cb = lerp3(t, d.midPoint, d.colors[0][2], d.colors[1][2], d.colors[2][2]) / 255;
      const ca = lerp3(t, d.midPoint, d.colors[0][3], d.colors[1][3], d.colors[2][3]) / 255;
      // texture tile: animate through lifespan cells then decay cells
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
      // rotated billboard axes
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

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
    lastT = now;
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.055, 0.062, 0.078, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);

    if (spin && !dragging) yaw += 0.004;
    const c = model ? model.center : [0, 0, 0.5];
    const d = model ? dist : 6;
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

    // grid
    gl.useProgram(meshProg);
    gl.uniform1i(mLoc.uTex, 0);
    gl.uniformMatrix4fv(mLoc.uModel, false, new Float32Array(IDENT));
    const gs = model ? Math.max(model.radius, 0.5) : 1;
    const gridMvp = mul(mvp, [gs, 0, 0, 0, 0, gs, 0, 0, 0, 0, gs, 0, c[0], c[1], 0, 1]);
    gl.uniformMatrix4fv(mLoc.uMVP, false, new Float32Array(gridMvp));
    gl.uniform3f(mLoc.uColor, 0.16, 0.18, 0.22);
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

    // mesh
    if (mesh) {
      gl.uniformMatrix4fv(mLoc.uMVP, false, new Float32Array(mvp));
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
        gl.disable(gl.BLEND);
        gl.bindTexture(gl.TEXTURE_2D, whiteTex);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.wibo);
        gl.drawElements(gl.LINES, mesh.wcount, gl.UNSIGNED_SHORT, 0);
      } else {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
        for (const b of mesh.batches) {
          const tex = b.texture >= 0 ? model.textures[b.texture] : null;
          gl.bindTexture(gl.TEXTURE_2D, tex || whiteTex);
          gl.uniform1f(mLoc.uHasTex, tex ? 1 : 0);
          gl.uniform3f(mLoc.uColor, tex ? 1 : 0.62, tex ? 1 : 0.66, tex ? 1 : 0.74);
          gl.uniform1f(mLoc.uFlat, b.unlit ? 1 : 0);
          const st = applyBlend(b.blend);
          gl.uniform1f(mLoc.uAlphaTest, st.alphaTest);
          gl.depthMask(st.depthWrite);
          gl.drawElements(gl.TRIANGLES, b.indexCount, gl.UNSIGNED_SHORT, b.indexStart * 2);
        }
        gl.depthMask(true);
      }
    }

    // particles
    if (model && model.emitters.length && particlesOn) {
      simulate(dt);
      gl.useProgram(partProg);
      gl.uniform1i(pLoc.uTex, 0);
      gl.uniformMatrix4fv(pLoc.uMVP, false, new Float32Array(mvp));
      gl.depthMask(false);
      let base = 0;
      const draws = [];
      for (const e of model.emitters) {
        const n = fillParticles(e, right, up, base);
        if (n > 0) draws.push({ e, base, n });
        base += n;
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
          const tex = texIdx >= 0 ? model.textures[texIdx] : null;
          gl.bindTexture(gl.TEXTURE_2D, tex || whiteTex);
          gl.uniform1f(pLoc.uHasTex, tex ? 1 : 0);
          applyBlend(dr.e.def.blendingType);
          gl.drawArrays(gl.TRIANGLES, dr.base * 6, dr.n * 6);
        }
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame((t) => { lastT = t; requestAnimationFrame(frame); });

  canvas.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    yaw -= (e.clientX - lastX) * 0.008;
    pitch = Math.min(1.5, Math.max(-1.5, pitch + (e.clientY - lastY) * 0.008));
    lastX = e.clientX; lastY = e.clientY;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    dist *= e.deltaY > 0 ? 1.12 : 0.89;
    dist = Math.max(0.2, Math.min(300, dist));
  }, { passive: false });

  return {
    show, clear, setTexture,
    setWireframe: (b) => { wireframe = b; },
    setSpin: (b) => { spin = b; },
    setParticles: (b) => { particlesOn = b; },
  };
})();
