// Bakes a rigid transform (uniform scale, ZYX euler rotation, translation) into a
// vanilla M2 file, producing a new model whose geometry sits at the adjusted
// position. This is how 1.12 does "XYZ offsets" — the DBCs have no such fields,
// so the offset must live in the model itself (cf. the WSG flag models).
//
// Transformed: vertex positions/normals, bone pivots, attachment positions,
// particle emitter positions (+ speed/area/scale magnitudes), bounding and
// collision boxes/radii, collision vertices/normals.
// Not transformed (acceptable for props): bone animation translation tracks,
// ribbon emitter positions, cameras/lights.

const PARTICLE_SIZE = 0x1F8;
const TRACK_SIZE = 0x1C;

function bakeM2(src, { offset = [0, 0, 0], yaw = 0, pitch = 0, roll = 0, scale = 1 } = {}) {
  const buf = Buffer.from(src); // copy — we edit in place
  if (buf.toString('ascii', 0, 4) !== 'MD20') throw new Error('not an M2');
  const version = buf.readUInt32LE(4);
  if (version > 263) throw new Error(`M2 version ${version} is not a classic-era model`);
  if (!(scale > 0.001 && scale < 1000)) throw new Error('scale out of range');

  // rotation matrix R = Rz(yaw) * Ry(pitch) * Rx(roll)
  const cz = Math.cos(yaw), sz = Math.sin(yaw);
  const cy = Math.cos(pitch), sy = Math.sin(pitch);
  const cx = Math.cos(roll), sx = Math.sin(roll);
  const R = [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
  const xformPoint = (x, y, z) => {
    x *= scale; y *= scale; z *= scale;
    return [
      R[0][0] * x + R[0][1] * y + R[0][2] * z + offset[0],
      R[1][0] * x + R[1][1] * y + R[1][2] * z + offset[1],
      R[2][0] * x + R[2][1] * y + R[2][2] * z + offset[2],
    ];
  };
  const xformDir = (x, y, z) => [
    R[0][0] * x + R[0][1] * y + R[0][2] * z,
    R[1][0] * x + R[1][1] * y + R[1][2] * z,
    R[2][0] * x + R[2][1] * y + R[2][2] * z,
  ];

  const arr = (off) => ({ count: buf.readUInt32LE(off), offset: buf.readUInt32LE(off + 4) });
  const inBounds = (o, len) => o + len <= buf.length;
  const writeVec = (o, v) => {
    buf.writeFloatLE(v[0], o); buf.writeFloatLE(v[1], o + 4); buf.writeFloatLE(v[2], o + 8);
  };
  const pointAt = (o) => xformPoint(buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8));
  const dirAt = (o) => xformDir(buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8));

  // vertices (48-byte stride: pos @0, normal @20)
  const verts = arr(0x44);
  if (inBounds(verts.offset, verts.count * 48)) {
    for (let i = 0; i < verts.count; i++) {
      const o = verts.offset + i * 48;
      writeVec(o, pointAt(o));
      writeVec(o + 20, dirAt(o + 20));
    }
  }

  // bone pivots (vanilla bone = 0x6C bytes, pivot @0x60)
  const bones = arr(0x34);
  if (bones.count <= 512 && inBounds(bones.offset, bones.count * 0x6C)) {
    for (let i = 0; i < bones.count; i++) {
      const o = bones.offset + i * 0x6C + 0x60;
      writeVec(o, pointAt(o));
    }
  }

  // attachments (48 bytes, position @8)
  const atts = arr(0x104);
  if (atts.count <= 96 && inBounds(atts.offset, atts.count * 48)) {
    for (let i = 0; i < atts.count; i++) {
      const o = atts.offset + i * 48 + 8;
      writeVec(o, pointAt(o));
    }
  }

  // particle emitters: position @0x08; scale speed/area track values and size keys
  const parts = arr(0x13C);
  if (parts.count <= 64 && inBounds(parts.offset, parts.count * PARTICLE_SIZE)) {
    const scaleTrackValues = (trackOfs) => {
      const count = buf.readUInt32LE(trackOfs + 0x14);
      const ofs = buf.readUInt32LE(trackOfs + 0x18);
      if (count > 0 && count < 10000 && inBounds(ofs, count * 4)) {
        for (let i = 0; i < count; i++) {
          buf.writeFloatLE(buf.readFloatLE(ofs + i * 4) * scale, ofs + i * 4);
        }
      }
    };
    for (let i = 0; i < parts.count; i++) {
      const o = parts.offset + i * PARTICLE_SIZE;
      writeVec(o + 0x08, pointAt(o + 0x08));
      if (scale !== 1) {
        // emissionSpeed(0), gravity(4), areaWidth(7), areaLength(8) — track index * TRACK_SIZE from o+0x34
        for (const ti of [0, 4, 7, 8]) scaleTrackValues(o + 0x34 + ti * TRACK_SIZE);
        // particle size keys (scaleValues[3] at params +16)
        const p = o + 0x14C + 16;
        for (let k = 0; k < 3; k++) buf.writeFloatLE(buf.readFloatLE(p + k * 4) * scale, p + k * 4);
      }
    }
  }

  // bounding box @0xB4 (min,max), radius @0xCC; collision box @0xD0, radius @0xE8
  for (const [boxOfs, radOfs] of [[0xB4, 0xCC], [0xD0, 0xE8]]) {
    const min = [buf.readFloatLE(boxOfs), buf.readFloatLE(boxOfs + 4), buf.readFloatLE(boxOfs + 8)];
    const max = [buf.readFloatLE(boxOfs + 12), buf.readFloatLE(boxOfs + 16), buf.readFloatLE(boxOfs + 20)];
    const nmin = [Infinity, Infinity, Infinity], nmax = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const p = xformPoint(c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]);
      for (let a = 0; a < 3; a++) {
        if (p[a] < nmin[a]) nmin[a] = p[a];
        if (p[a] > nmax[a]) nmax[a] = p[a];
      }
    }
    writeVec(boxOfs, nmin);
    writeVec(boxOfs + 12, nmax);
    buf.writeFloatLE(buf.readFloatLE(radOfs) * scale, radOfs);
  }

  // collision vertices @0xF4, collision normals @0xFC
  const colV = arr(0xF4);
  if (inBounds(colV.offset, colV.count * 12)) {
    for (let i = 0; i < colV.count; i++) writeVec(colV.offset + i * 12, pointAt(colV.offset + i * 12));
  }
  const colN = arr(0xFC);
  if (inBounds(colN.offset, colN.count * 12)) {
    for (let i = 0; i < colN.count; i++) writeVec(colN.offset + i * 12, dirAt(colN.offset + i * 12));
  }

  return buf;
}

module.exports = { bakeM2 };
