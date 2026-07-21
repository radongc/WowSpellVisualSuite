// WDBC (classic-era .dbc) reader/writer, schema-driven.
const { fieldColumns, schemaColumns } = require('./schemas');

const HEADER_SIZE = 20;
const MAGIC = 'WDBC';
const LOC_LANGS = ['enUS', 'koKR', 'frFR', 'deDE', 'zhCN', 'zhTW', 'esES', 'esMX'];

function readString(buf, strBase, offset) {
  if (offset === 0) return '';
  const start = strBase + offset;
  if (start >= buf.length) return '';
  let end = start;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.toString('utf8', start, end);
}

// Parse a .dbc buffer into { header, records: [record objects] }.
// Loc fields become { enUS: '...', ..., flags: n }; array fields become arrays.
function parse(buf, schema, name) {
  if (buf.length < HEADER_SIZE) throw new Error(`${name}: file too small (${buf.length} bytes)`);
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== MAGIC) throw new Error(`${name}: bad magic "${magic}"`);
  const recordCount = buf.readUInt32LE(4);
  const fieldCount = buf.readUInt32LE(8);
  const recordSize = buf.readUInt32LE(12);
  const stringBlockSize = buf.readUInt32LE(16);
  const expected = HEADER_SIZE + recordCount * recordSize + stringBlockSize;
  if (expected !== buf.length) {
    throw new Error(`${name}: truncated or corrupt — header implies ${expected} bytes, file is ${buf.length}`);
  }
  const expectedCols = schemaColumns(schema);
  if (fieldCount !== expectedCols) {
    throw new Error(`${name}: schema mismatch — file has ${fieldCount} fields, schema defines ${expectedCols}`);
  }
  if (recordSize !== fieldCount * 4) {
    throw new Error(`${name}: unsupported record size ${recordSize} for ${fieldCount} fields`);
  }

  const strBase = HEADER_SIZE + recordCount * recordSize;
  const records = [];
  for (let r = 0; r < recordCount; r++) {
    let off = HEADER_SIZE + r * recordSize;
    const rec = {};
    for (const fld of schema) {
      const n = fld.arraySize || 1;
      const readOne = () => {
        let v;
        if (fld.type === 'float') v = buf.readFloatLE(off);
        else if (fld.type === 'uint') v = buf.readUInt32LE(off);
        else if (fld.type === 'string') v = readString(buf, strBase, buf.readUInt32LE(off));
        else if (fld.type === 'loc') {
          v = {};
          for (const lang of LOC_LANGS) {
            v[lang] = readString(buf, strBase, buf.readUInt32LE(off));
            off += 4;
          }
          v.flags = buf.readUInt32LE(off);
        } else v = buf.readInt32LE(off);
        off += 4;
        return v;
      };
      if (fld.arraySize) {
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(readOne());
        rec[fld.name] = arr;
      } else {
        rec[fld.name] = readOne();
      }
    }
    records.push(rec);
  }
  return { records, fieldCount, recordSize };
}

// Serialize records back to a WDBC buffer.
function write(records, schema, name) {
  const cols = schemaColumns(schema);
  const recordSize = cols * 4;
  // Build string block with dedup. Offset 0 is a single NUL, empty string maps to 0.
  const strParts = [Buffer.from([0])];
  let strLen = 1;
  const strMap = new Map([['', 0]]);
  const internString = (s) => {
    s = String(s ?? '');
    if (strMap.has(s)) return strMap.get(s);
    const off = strLen;
    const b = Buffer.from(s + '\0', 'utf8');
    strParts.push(b);
    strLen += b.length;
    strMap.set(s, off);
    return off;
  };

  const body = Buffer.alloc(records.length * recordSize);
  let off = 0;
  for (const rec of records) {
    for (const fld of schema) {
      const vals = fld.arraySize ? rec[fld.name] : [rec[fld.name]];
      const n = fld.arraySize || 1;
      if (!fld.arraySize && vals.length !== 1) throw new Error('internal');
      if (fld.arraySize && (!Array.isArray(vals) || vals.length !== n)) {
        throw new Error(`${name}: field ${fld.name} expects array of ${n}`);
      }
      for (let i = 0; i < n; i++) {
        const v = vals[i];
        if (fld.type === 'float') { body.writeFloatLE(Number(v) || 0, off); off += 4; }
        else if (fld.type === 'uint') { body.writeUInt32LE((Number(v) || 0) >>> 0, off); off += 4; }
        else if (fld.type === 'string') { body.writeUInt32LE(internString(v), off); off += 4; }
        else if (fld.type === 'loc') {
          const loc = v || {};
          for (const lang of LOC_LANGS) { body.writeUInt32LE(internString(loc[lang] || ''), off); off += 4; }
          body.writeUInt32LE((Number(loc.flags) || 0) >>> 0, off); off += 4;
        } else { body.writeInt32LE((Number(v) || 0) | 0, off); off += 4; }
      }
    }
  }

  const strBlock = Buffer.concat(strParts, strLen);
  const header = Buffer.alloc(HEADER_SIZE);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt32LE(records.length, 4);
  header.writeUInt32LE(cols, 8);
  header.writeUInt32LE(recordSize, 12);
  header.writeUInt32LE(strBlock.length, 16);
  return Buffer.concat([header, body, strBlock]);
}

module.exports = { parse, write, LOC_LANGS };
