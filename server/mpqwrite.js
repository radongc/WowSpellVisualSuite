// Minimal MPQ v0 archive writer (uncompressed entries) — enough to build a
// vanilla-compatible patch archive from baked model files. Verified readable
// by StormLib.
const cryptTable = new Uint32Array(0x500);
(function () {
  let seed = 0x00100001;
  for (let i1 = 0; i1 < 0x100; i1++) {
    for (let i = 0, i2 = i1; i < 5; i++, i2 += 0x100) {
      seed = (seed * 125 + 3) % 0x2AAAAB;
      const t1 = (seed & 0xFFFF) << 16;
      seed = (seed * 125 + 3) % 0x2AAAAB;
      const t2 = seed & 0xFFFF;
      cryptTable[i2] = (t1 | t2) >>> 0;
    }
  }
})();

function hashString(str, type) {
  let seed1 = 0x7FED7FED >>> 0, seed2 = 0xEEEEEEEE >>> 0;
  for (let i = 0; i < str.length; i++) {
    let ch = str[i] === '/' ? '\\' : str[i];
    ch = ch.toUpperCase().charCodeAt(0);
    seed1 = (cryptTable[(type << 8) + ch] ^ ((seed1 + seed2) >>> 0)) >>> 0;
    seed2 = (ch + seed1 + seed2 + ((seed2 << 5) >>> 0) + 3) >>> 0;
  }
  return seed1;
}

function encryptBlock(u32, key) {
  let seed = 0xEEEEEEEE >>> 0;
  key = key >>> 0;
  for (let i = 0; i < u32.length; i++) {
    seed = (seed + cryptTable[0x400 + (key & 0xFF)]) >>> 0;
    const ch = u32[i];
    u32[i] = (ch ^ ((key + seed) >>> 0)) >>> 0;
    key = ((((~key >>> 0) << 0x15) >>> 0) + 0x11111111 | (key >>> 0x0B)) >>> 0;
    seed = (ch + seed + ((seed << 5) >>> 0) + 3) >>> 0;
  }
  return u32;
}

// files: [{ name: 'Spells\\Foo.m2', data: Buffer }]
function buildMpq(userFiles) {
  if (!userFiles.length) throw new Error('no files to pack');
  // include a (listfile) so MPQ tools can enumerate contents by name
  const files = [
    ...userFiles,
    { name: '(listfile)', data: Buffer.from(userFiles.map((f) => f.name).join('\r\n') + '\r\n', 'utf8') },
  ];
  let hashSize = 4;
  while (hashSize < files.length * 2) hashSize *= 2;

  const headerSize = 0x20;
  let pos = headerSize;
  const blocks = [];
  for (const f of files) {
    blocks.push({ filePos: pos, size: f.data.length });
    pos += f.data.length;
  }
  const hashPos = pos;
  const blockPos = hashPos + hashSize * 16;
  const archiveSize = blockPos + files.length * 16;

  const hash = new Uint32Array(hashSize * 4).fill(0xFFFFFFFF);
  files.forEach((f, bi) => {
    const start = hashString(f.name, 0) & (hashSize - 1);
    let idx = start;
    while (hash[idx * 4 + 3] !== 0xFFFFFFFF) {
      idx = (idx + 1) & (hashSize - 1);
      if (idx === start) throw new Error('hash table full');
    }
    hash[idx * 4] = hashString(f.name, 1);
    hash[idx * 4 + 1] = hashString(f.name, 2);
    hash[idx * 4 + 2] = 0; // locale neutral, platform 0
    hash[idx * 4 + 3] = bi;
  });

  const block = new Uint32Array(files.length * 4);
  blocks.forEach((b, i) => {
    block[i * 4] = b.filePos;
    block[i * 4 + 1] = b.size;      // compressed size (== raw: uncompressed)
    block[i * 4 + 2] = b.size;
    block[i * 4 + 3] = 0x80000000;  // MPQ_FILE_EXISTS
  });

  encryptBlock(hash, hashString('(hash table)', 3));
  encryptBlock(block, hashString('(block table)', 3));

  const out = Buffer.alloc(archiveSize);
  out.write('MPQ\x1A', 0, 'latin1');
  out.writeUInt32LE(headerSize, 4);
  out.writeUInt32LE(archiveSize, 8);
  out.writeUInt16LE(0, 12);   // format version 0
  out.writeUInt16LE(3, 14);   // sector size shift (unused for uncompressed)
  out.writeUInt32LE(hashPos, 16);
  out.writeUInt32LE(blockPos, 20);
  out.writeUInt32LE(hashSize, 24);
  out.writeUInt32LE(files.length, 28);
  files.forEach((f, i) => f.data.copy(out, blocks[i].filePos));
  Buffer.from(hash.buffer).copy(out, hashPos);
  Buffer.from(block.buffer).copy(out, blockPos);
  return out;
}

module.exports = { buildMpq };
