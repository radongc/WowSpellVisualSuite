// M2 (vanilla, version 256-257) extractor for preview rendering: geometry from
// embedded view 0, textures/materials/batches, and particle emitter definitions.
//
// Vanilla header layout (offsets after magic+version, each M2Array = count,offset):
//   0x08 name, 0x10 flags, 0x14 globalSequences, 0x1C sequences, 0x24 seqLookup,
//   0x2C playableAnimLookup, 0x34 bones, 0x3C keyBoneLookup, 0x44 vertices,
//   0x4C views, 0x54 colors, 0x5C textures, 0x64 transparency, 0x6C flipbooks,
//   0x74 texAnims, 0x7C texReplace, 0x84 renderFlags, 0x8C boneLookup,
//   0x94 texLookup, 0x9C texUnitLookup, 0xA4 transLookup, 0xAC texAnimLookup,
//   0xB4 boundingBox.., 0x134 ribbonEmitters, 0x13C particleEmitters
// Vertex stride is 48: pos(3f) boneWeights(4b) boneIndices(4b) normal(3f) uv(2f) pad(2f)

function parseM2(buf) {
  if (buf.length < 0x144) throw new Error('file too small to be an M2');
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'MD20') throw new Error(`not an M2 (magic ${JSON.stringify(magic)})`);
  const version = buf.readUInt32LE(4);
  if (version > 263) throw new Error(`M2 version ${version} is not a classic-era model`);

  const arr = (off) => ({ count: buf.readUInt32LE(off), offset: buf.readUInt32LE(off + 4) });
  const check = (o, len, what) => {
    if (o + len > buf.length) throw new Error(`corrupt M2: ${what} out of bounds`);
  };

  const nameArr = arr(0x08);
  let name = '';
  if (nameArr.count > 0 && nameArr.offset + nameArr.count <= buf.length) {
    name = buf.toString('utf8', nameArr.offset, nameArr.offset + nameArr.count).replace(/\0+$/, '');
  }

  // --- textures (shared by mesh batches and particles) ---
  let textures = [];
  try {
    const texArr = arr(0x5C);
    if (texArr.count > 0 && texArr.count <= 64 && texArr.offset + texArr.count * 16 <= buf.length) {
      for (let i = 0; i < texArr.count; i++) {
        const o = texArr.offset + i * 16;
        const type = buf.readUInt32LE(o);
        const len = buf.readUInt32LE(o + 8);
        const ofs = buf.readUInt32LE(o + 12);
        if (type > 20) throw new Error('texture type out of range');
        let fileName = '';
        if (type === 0 && len > 1 && ofs + len <= buf.length) {
          fileName = buf.toString('utf8', ofs, ofs + len).replace(/\0+$/, '');
        }
        textures.push({ type, fileName });
      }
    }
  } catch (e) {
    textures = [];
  }

  // --- particle emitters (vanilla M2ParticleOld, 0x1F8 bytes each) ---
  const particles = parseParticles(buf, arr, textures.length);

  const vertices = arr(0x44);
  const views = arr(0x4C);
  const VSTRIDE = 48;
  check(vertices.offset, vertices.count * VSTRIDE, 'vertices');
  if (vertices.count === 0 || views.count === 0) {
    // Pure particle-emitter model (precast glows, sprays, etc.) — no mesh.
    return {
      name, version, particleOnly: true, vertexCount: 0,
      positions: [], normals: [], uvs: [], indices: [], batches: [], textures, particles,
    };
  }

  const positions = new Array(vertices.count * 3);
  const normals = new Array(vertices.count * 3);
  const uvs = new Array(vertices.count * 2);
  for (let i = 0; i < vertices.count; i++) {
    const o = vertices.offset + i * VSTRIDE;
    positions[i * 3] = buf.readFloatLE(o);
    positions[i * 3 + 1] = buf.readFloatLE(o + 4);
    positions[i * 3 + 2] = buf.readFloatLE(o + 8);
    normals[i * 3] = buf.readFloatLE(o + 20);
    normals[i * 3 + 1] = buf.readFloatLE(o + 24);
    normals[i * 3 + 2] = buf.readFloatLE(o + 28);
    uvs[i * 2] = buf.readFloatLE(o + 32);
    uvs[i * 2 + 1] = buf.readFloatLE(o + 36);
  }

  // M2View (<= TBC): indices, triangles, properties, submeshes, textureUnits (M2Arrays), lod
  const VIEW_SIZE = 44;
  check(views.offset, VIEW_SIZE, 'view 0');
  const vo = views.offset;
  const vIndices = arr(vo);
  const vTris = arr(vo + 8);
  check(vIndices.offset, vIndices.count * 2, 'view indices');
  check(vTris.offset, vTris.count * 2, 'view triangles');

  const lookup = new Array(vIndices.count);
  for (let i = 0; i < vIndices.count; i++) lookup[i] = buf.readUInt16LE(vIndices.offset + i * 2);
  const indices = new Array(vTris.count);
  for (let i = 0; i < vTris.count; i++) {
    const li = buf.readUInt16LE(vTris.offset + i * 2);
    indices[i] = li < lookup.length ? lookup[li] : 0;
  }

  // --- materials / batches (validated; degrade to untextured single batch) ---
  let batches = [];
  try {
    const rfArr = arr(0x84);
    const materials = [];
    if (rfArr.count > 0 && rfArr.count <= 256 && rfArr.offset + rfArr.count * 4 <= buf.length) {
      for (let i = 0; i < rfArr.count; i++) {
        const o = rfArr.offset + i * 4;
        materials.push({ flags: buf.readUInt16LE(o), blend: buf.readUInt16LE(o + 2) });
      }
      if (materials.some((m) => m.blend > 7)) throw new Error('render flags failed validation');
    }

    const tlArr = arr(0x94);
    const texLookup = [];
    if (tlArr.count > 0 && tlArr.count <= 256 && tlArr.offset + tlArr.count * 2 <= buf.length) {
      for (let i = 0; i < tlArr.count; i++) texLookup.push(buf.readUInt16LE(tlArr.offset + i * 2));
      if (texLookup.some((t) => t !== 0xFFFF && t >= textures.length)) throw new Error('texture lookup failed validation');
    }

    // view 0 submeshes (32 bytes each in vanilla) and texture units (24 bytes each)
    const vSub = arr(vo + 24);
    const vUnits = arr(vo + 32);
    const submeshes = [];
    if (vSub.count > 0 && vSub.offset + vSub.count * 32 <= buf.length) {
      for (let i = 0; i < vSub.count; i++) {
        const o = vSub.offset + i * 32;
        submeshes.push({ indexStart: buf.readUInt16LE(o + 8), indexCount: buf.readUInt16LE(o + 10) });
      }
      if (submeshes.some((s) => s.indexStart + s.indexCount > indices.length)) throw new Error('submeshes failed validation');
    }
    if (vUnits.count > 0 && vUnits.count <= 512 && vUnits.offset + vUnits.count * 24 <= buf.length && submeshes.length) {
      for (let i = 0; i < vUnits.count; i++) {
        const o = vUnits.offset + i * 24;
        const skinSectionIndex = buf.readUInt16LE(o + 4);
        const materialIndex = buf.readUInt16LE(o + 10);
        const textureComboIndex = buf.readUInt16LE(o + 16);
        if (skinSectionIndex >= submeshes.length) throw new Error('batch submesh index out of range');
        const sub = submeshes[skinSectionIndex];
        const texIdx = textureComboIndex < texLookup.length ? texLookup[textureComboIndex] : 0xFFFF;
        const mat = materials[materialIndex] || { flags: 0, blend: 2 };
        batches.push({
          indexStart: sub.indexStart,
          indexCount: sub.indexCount,
          texture: texIdx !== 0xFFFF && texIdx < textures.length ? texIdx : -1,
          blend: mat.blend,
          unlit: !!(mat.flags & 0x01),
          twoSided: !!(mat.flags & 0x04),
          noDepthWrite: !!(mat.flags & 0x10),
        });
      }
    }
  } catch (e) {
    batches = [];
  }

  return { name, version, vertexCount: vertices.count, positions, normals, uvs, indices, textures, batches, particles };
}

// Vanilla M2ParticleOld (504 bytes). Track values are sampled at their first
// keyframe — good enough for a static-emitter preview.
const PARTICLE_SIZE = 0x1F8;
const TRACK_SIZE = 0x1C; // u16 interp, s16 gseq, M2Array ranges, M2Array times, M2Array values

function parseParticles(buf, arr, textureCount) {
  const out = [];
  try {
    const pArr = arr(0x13C);
    if (pArr.count === 0) return out;
    if (pArr.count > 64 || pArr.offset + pArr.count * PARTICLE_SIZE > buf.length) return out;

    const trackFirst = (o, fallback, isByte) => {
      // values M2Array lives at track offset +0x14
      const count = buf.readUInt32LE(o + 0x14);
      const ofs = buf.readUInt32LE(o + 0x18);
      if (count === 0) return fallback;
      if (isByte) {
        if (ofs + 1 > buf.length) return fallback;
        return buf.readUInt8(ofs);
      }
      if (ofs + 4 > buf.length) return fallback;
      const v = buf.readFloatLE(ofs);
      return Number.isFinite(v) ? v : fallback;
    };

    for (let i = 0; i < pArr.count; i++) {
      const o = pArr.offset + i * PARTICLE_SIZE;
      const flags = buf.readUInt32LE(o + 0x04);
      const pos = [buf.readFloatLE(o + 0x08), buf.readFloatLE(o + 0x0C), buf.readFloatLE(o + 0x10)];
      const texture = buf.readUInt16LE(o + 0x16);
      const blendingType = buf.readUInt16LE(o + 0x28);
      const emitterType = buf.readUInt16LE(o + 0x2A);
      const headOrTail = buf.readUInt8(o + 0x2D);
      const rows = buf.readUInt16LE(o + 0x30) || 1;
      const columns = buf.readUInt16LE(o + 0x32) || 1;
      // struct sanity — one bad field means the layout doesn't match, drop all
      if (blendingType > 7 || emitterType > 4 || pos.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e5)) {
        return [];
      }
      let t = o + 0x34;
      const emissionSpeed = trackFirst(t, 1); t += TRACK_SIZE;
      const speedVariation = trackFirst(t, 0); t += TRACK_SIZE;
      const verticalRange = trackFirst(t, 0); t += TRACK_SIZE;
      const horizontalRange = trackFirst(t, 0); t += TRACK_SIZE;
      const gravity = trackFirst(t, 0); t += TRACK_SIZE;
      const lifespan = trackFirst(t, 1); t += TRACK_SIZE;
      const emissionRate = trackFirst(t, 8); t += TRACK_SIZE;
      const areaWidth = trackFirst(t, 0); t += TRACK_SIZE;
      const areaLength = trackFirst(t, 0); t += TRACK_SIZE;
      const zSource = trackFirst(t, 0); t += TRACK_SIZE;
      // fixed params block at o+0x14C
      const p = o + 0x14C;
      const midPoint = buf.readFloatLE(p);
      const colors = [];
      for (let c = 0; c < 3; c++) {
        const co = p + 4 + c * 4; // CImVector = BGRA bytes
        colors.push([buf.readUInt8(co + 2), buf.readUInt8(co + 1), buf.readUInt8(co), buf.readUInt8(co + 3)]);
      }
      const scales = [buf.readFloatLE(p + 16), buf.readFloatLE(p + 20), buf.readFloatLE(p + 24)];
      const lifespanUVAnim = [buf.readUInt16LE(p + 28), buf.readUInt16LE(p + 30), buf.readUInt16LE(p + 32)];
      const decayUVAnim = [buf.readUInt16LE(p + 34), buf.readUInt16LE(p + 36), buf.readUInt16LE(p + 38)];
      const tailLength = buf.readFloatLE(o + 0x17C);
      const drag = buf.readFloatLE(o + 0x194);
      const spin = buf.readFloatLE(o + 0x198);
      const windVector = [buf.readFloatLE(o + 0x1B4), buf.readFloatLE(o + 0x1B8), buf.readFloatLE(o + 0x1BC)];

      if (!Number.isFinite(midPoint) || scales.some((s) => !Number.isFinite(s) || Math.abs(s) > 1e5)) return [];

      out.push({
        flags, pos,
        texture: texture < textureCount ? texture : -1,
        blendingType, emitterType, headOrTail, rows, columns,
        emissionSpeed, speedVariation,
        verticalRange, horizontalRange, gravity,
        lifespan: Math.max(0.05, lifespan),
        emissionRate: Math.max(0, emissionRate),
        areaWidth, areaLength, zSource,
        midPoint: Math.min(1, Math.max(0.01, midPoint || 0.5)),
        colors, scales, lifespanUVAnim, decayUVAnim,
        tailLength: Number.isFinite(tailLength) ? tailLength : 0,
        drag: Number.isFinite(drag) ? drag : 0,
        spin: Number.isFinite(spin) ? spin : 0,
        windVector: windVector.every(Number.isFinite) ? windVector : [0, 0, 0],
      });
    }
  } catch (e) {
    return [];
  }
  return out;
}

module.exports = { parseM2 };
