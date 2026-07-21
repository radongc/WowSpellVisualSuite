// BLP2 texture decoder (vanilla WoW format) → RGBA8 pixels for the top mip.
// Supports: palettized (0/1/4/8-bit alpha), DXT1/3/5, uncompressed BGRA.

function decodeBLP(buf) {
  if (buf.length < 148 + 1024) throw new Error('file too small to be a BLP2');
  if (buf.toString('ascii', 0, 4) !== 'BLP2') throw new Error('not a BLP2 file');
  const type = buf.readUInt32LE(4);
  if (type !== 1) throw new Error(`unsupported BLP type ${type} (JPEG)`);
  const compression = buf.readUInt8(8);   // 1 palettized, 2 DXT, 3 raw BGRA
  const alphaDepth = buf.readUInt8(9);
  const alphaType = buf.readUInt8(10);
  const width = buf.readUInt32LE(12);
  const height = buf.readUInt32LE(16);
  const mipOfs = buf.readUInt32LE(20);
  const mipSize = buf.readUInt32LE(84);
  if (!width || !height || width > 4096 || height > 4096) throw new Error(`bad dimensions ${width}x${height}`);
  if (mipOfs + mipSize > buf.length) throw new Error('mip 0 out of bounds');
  const data = buf.subarray(mipOfs, mipOfs + mipSize);
  const out = new Uint8Array(width * height * 4);

  if (compression === 3) {
    // raw BGRA
    for (let i = 0; i < width * height; i++) {
      out[i * 4] = data[i * 4 + 2];
      out[i * 4 + 1] = data[i * 4 + 1];
      out[i * 4 + 2] = data[i * 4];
      out[i * 4 + 3] = data[i * 4 + 3];
    }
    return { width, height, rgba: out };
  }

  if (compression === 1) {
    // 256-color palette (BGRA entries at 148), then indices, then packed alpha
    const palOfs = 148;
    const alphaOfs = width * height;
    for (let i = 0; i < width * height; i++) {
      const p = palOfs + data[i] * 4;
      out[i * 4] = buf[p + 2];
      out[i * 4 + 1] = buf[p + 1];
      out[i * 4 + 2] = buf[p];
      let a = 255;
      if (alphaDepth === 1) a = (data[alphaOfs + (i >> 3)] >> (i & 7)) & 1 ? 255 : 0;
      else if (alphaDepth === 4) a = ((data[alphaOfs + (i >> 1)] >> ((i & 1) * 4)) & 0xF) * 17;
      else if (alphaDepth === 8) a = data[alphaOfs + i];
      out[i * 4 + 3] = a;
    }
    return { width, height, rgba: out };
  }

  if (compression === 2) {
    // DXT: alphaDepth 0/1 → DXT1; alphaDepth 8 + alphaType 1 → DXT3; alphaType 7 → DXT5
    const dxt = alphaDepth > 1 ? (alphaType === 7 ? 5 : 3) : 1;
    decodeDXT(data, width, height, dxt, out, alphaDepth);
    return { width, height, rgba: out };
  }

  throw new Error(`unsupported BLP compression ${compression}`);
}

function decodeDXT(data, width, height, mode, out, alphaDepth) {
  const blockBytes = mode === 1 ? 8 : 16;
  const bw = Math.max(1, width >> 2), bh = Math.max(1, height >> 2);
  let src = 0;
  const c = [[0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255]];
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, src += blockBytes) {
      if (src + blockBytes > data.length) return;
      const co = mode === 1 ? src : src + 8;
      const c0 = data[co] | (data[co + 1] << 8);
      const c1 = data[co + 2] | (data[co + 3] << 8);
      const bits = data[co + 4] | (data[co + 5] << 8) | (data[co + 6] << 16) | (data[co + 7] << 24);
      expand565(c0, c[0]);
      expand565(c1, c[1]);
      const opaque1bit = mode === 1 && alphaDepth >= 1 && c0 <= c1;
      if (mode !== 1 || c0 > c1) {
        for (let k = 0; k < 3; k++) {
          c[2][k] = (2 * c[0][k] + c[1][k] + 1) / 3 | 0;
          c[3][k] = (c[0][k] + 2 * c[1][k] + 1) / 3 | 0;
        }
        c[2][3] = 255; c[3][3] = 255;
      } else {
        for (let k = 0; k < 3; k++) {
          c[2][k] = (c[0][k] + c[1][k]) >> 1;
          c[3][k] = 0;
        }
        c[2][3] = 255;
        c[3][3] = opaque1bit ? 0 : 255; // transparent black in DXT1a
      }
      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= height) break;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= width) continue;
          const idx = (bits >>> ((py * 4 + px) * 2)) & 3;
          const o = (y * width + x) * 4;
          out[o] = c[idx][0]; out[o + 1] = c[idx][1]; out[o + 2] = c[idx][2];
          let a = c[idx][3];
          if (mode === 3) {
            const ai = py * 4 + px;
            const nib = (data[src + (ai >> 1)] >> ((ai & 1) * 4)) & 0xF;
            a = nib * 17;
          } else if (mode === 5) {
            a = dxt5Alpha(data, src, py * 4 + px);
          }
          out[o + 3] = a;
        }
      }
    }
  }
}

function expand565(v, dst) {
  dst[0] = ((v >> 11) & 31) * 255 / 31 | 0;
  dst[1] = ((v >> 5) & 63) * 255 / 63 | 0;
  dst[2] = (v & 31) * 255 / 31 | 0;
  dst[3] = 255;
}

function dxt5Alpha(data, src, texel) {
  const a0 = data[src], a1 = data[src + 1];
  // 48-bit index stream, 3 bits per texel
  const bitPos = texel * 3;
  const byte = 2 + (bitPos >> 3);
  const bits = (data[src + byte] | (data[src + byte + 1] << 8)) >> (bitPos & 7);
  const code = bits & 7;
  if (code === 0) return a0;
  if (code === 1) return a1;
  if (a0 > a1) return ((8 - code) * a0 + (code - 1) * a1 + 3) / 7 | 0;
  if (code === 6) return 0;
  if (code === 7) return 255;
  return ((6 - code) * a0 + (code - 1) * a1 + 2) / 5 | 0;
}

module.exports = { decodeBLP };
