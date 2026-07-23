// Optional MySQL backend for pairing with Stoneharry's WoW Spell Editor.
//
// Stoneharry imports DBCs into a MySQL database (one table per DBC, columns in
// binding order). When this tool is pointed at that same database, MySQL becomes
// the single source of truth: edits here go straight back to the shared tables,
// so there is no DBC-file round-trip and no drop-and-reimport to resync.
//
// The key trick is POSITIONAL mapping. Stoneharry's 1.12 SpellVisual /
// SpellVisualKit bindings use the TBC-derived column layout (StateDoneKit,
// weapon-effect slots, 3-wide char params), which is wrong for vanilla — this
// tool's schemas are corrected against the real client bytes. But column
// *order* is identical (both tables are the same width), and order is all that
// matters: MySQL column ordinal N == DBC byte offset N == this tool's schema
// field N. So we read/write by ordinal and ignore Stoneharry's field *names*,
// which makes the mislabeling invisible.
//
// mysql2 is an optional dependency, loaded only when MySQL is configured.

const { LOC_LANGS } = require('./dbc');
const { schemaColumns } = require('./schemas');

// ---- config ----

function config() {
  const database = process.env.MYSQL_DATABASE;
  if (!database) return null;
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database,
  };
}

function isConfigured() {
  return config() != null;
}

// ---- pure mapping core (exported for tests; no DB needed) ----

// Flatten a schema into its physical columns, in byte/ordinal order. A `loc`
// field becomes 8 language strings + a flags int; an array field becomes N
// scalars. The length equals schemaColumns(schema) and lines up 1:1 with the
// DBC record and with Stoneharry's MySQL columns.
function physicalColumns(schema) {
  const cols = [];
  for (const fld of schema) {
    if (fld.type === 'loc') {
      for (const lang of LOC_LANGS) cols.push({ field: fld.name, type: 'string', loc: lang });
      cols.push({ field: fld.name, type: 'uint', locFlags: true });
    } else {
      const n = fld.arraySize || 1;
      for (let i = 0; i < n; i++) {
        cols.push({ field: fld.name, type: fld.type, index: fld.arraySize ? i : null });
      }
    }
  }
  return cols;
}

const INT_SQL_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'bit']);
function isIntSqlType(dataType) {
  return INT_SQL_TYPES.has(String(dataType || '').toLowerCase());
}

// Reinterpret raw bits between float and uint. Needed when this tool treats a
// column as float but the DB stored it as an integer (Stoneharry types Speed,
// and the trailing kit column, as `uint`, so the stored value is the IEEE-754
// bit pattern, not the number).
const _bits = Buffer.alloc(4);
function uintBitsToFloat(u) { _bits.writeUInt32LE((u >>> 0), 0); return _bits.readFloatLE(0); }
function floatToUintBits(f) { _bits.writeFloatLE(Number(f) || 0, 0); return _bits.readUInt32LE(0); }

// Zip this tool's physical columns with the DB's actual columns (names + types,
// in ordinal order). Throws on a width mismatch so the caller can skip the table
// and fall back to file/archive rather than corrupt it.
function buildPlan(schema, dbColumns, tableName) {
  const phys = physicalColumns(schema);
  if (phys.length !== dbColumns.length) {
    throw new Error(`${tableName}: column count mismatch — schema has ${phys.length} physical columns, ` +
      `MySQL table has ${dbColumns.length}. Layout differs; skipping MySQL for this table.`);
  }
  return phys.map((p, i) => ({
    ...p,
    sqlName: dbColumns[i].name,
    // a float field stored in an integer column holds reinterpreted bits
    reinterpret: p.type === 'float' && isIntSqlType(dbColumns[i].dataType),
  }));
}

function assignInto(rec, col, value) {
  if (col.loc) { (rec[col.field] = rec[col.field] || {})[col.loc] = value; }
  else if (col.locFlags) { (rec[col.field] = rec[col.field] || {}).flags = value; }
  else if (col.index != null) { (rec[col.field] = rec[col.field] || [])[col.index] = value; }
  else { rec[col.field] = value; }
}

function coerceFromDb(col, raw) {
  if (col.type === 'string') return raw == null ? '' : String(raw);
  if (col.type === 'float') return col.reinterpret ? uintBitsToFloat(Number(raw) || 0) : (Number(raw) || 0);
  return Math.trunc(Number(raw) || 0); // int / uint
}

function rowToRecord(plan, row) {
  const rec = {};
  for (const col of plan) assignInto(rec, col, coerceFromDb(col, row[col.sqlName]));
  return rec;
}

function readFrom(rec, col) {
  if (col.loc) return (rec[col.field] || {})[col.loc] || '';
  if (col.locFlags) return Number((rec[col.field] || {}).flags) || 0;
  if (col.index != null) return (rec[col.field] || [])[col.index];
  return rec[col.field];
}

function coerceToDb(col, value) {
  if (col.type === 'string') return value == null ? '' : String(value);
  if (col.type === 'float') return col.reinterpret ? floatToUintBits(value) : (Number(value) || 0);
  return Math.trunc(Number(value) || 0);
}

// Produce a { sqlName: value } object for one record, ready for an upsert.
function recordToRow(plan, rec) {
  const row = {};
  for (const col of plan) row[col.sqlName] = coerceToDb(col, readFrom(rec, col));
  return row;
}

// ---- connection layer ----

let mysql = null;
let pool = null;
const planCache = new Map(); // dbc table name -> { table, plan } | null (unavailable)

function loadDriver() {
  if (mysql) return mysql;
  try { mysql = require('mysql2/promise'); }
  catch (e) {
    throw new Error('MySQL is configured but the "mysql2" package is not installed. ' +
      'Run `npm install mysql2` (it is an optional dependency).');
  }
  return mysql;
}

async function connect() {
  const cfg = config();
  if (!cfg) return false;
  const driver = loadDriver();
  pool = driver.createPool({ ...cfg, connectionLimit: 4, namedPlaceholders: false });
  await pool.query('SELECT 1'); // fail fast on bad credentials
  planCache.clear();
  return true;
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
  planCache.clear();
}

// Resolve a DBC table name to the real MySQL table + a cached column plan, or
// null if the table is absent / the layout doesn't line up.
async function resolve(name, schema) {
  if (planCache.has(name)) return planCache.get(name);
  const cfg = config();
  const [tbls] = await pool.query(
    'SELECT TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND LOWER(TABLE_NAME) = LOWER(?)',
    [cfg.database, name]);
  if (!tbls.length) { planCache.set(name, null); return null; }
  const table = tbls[0].t;
  const [cols] = await pool.query(
    'SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType FROM INFORMATION_SCHEMA.COLUMNS ' +
    'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [cfg.database, table]);
  let entry;
  try {
    entry = { table, plan: buildPlan(schema, cols, name) };
  } catch (e) {
    console.log(`  !! MySQL ${name}: ${e.message}`);
    entry = null;
  }
  planCache.set(name, entry);
  return entry;
}

async function hasTable(name, schema) {
  return (await resolve(name, schema)) != null;
}

function ident(s) { return '`' + String(s).replace(/`/g, '``') + '`'; }

// Read an entire table into this tool's record objects, mapped positionally.
async function readTable(name, schema) {
  const r = await resolve(name, schema);
  if (!r) return null;
  const colList = r.plan.map((c) => ident(c.sqlName)).join(', ');
  const [rows] = await pool.query(`SELECT ${colList} FROM ${ident(r.table)}`);
  return rows.map((row) => rowToRecord(r.plan, row));
}

// Upsert the given records (INSERT ... ON DUPLICATE KEY UPDATE). ID must be the
// primary key, which it is in Stoneharry's tables.
async function upsertRows(name, schema, records) {
  if (!records.length) return 0;
  const r = await resolve(name, schema);
  if (!r) throw new Error(`MySQL table for ${name} not available`);
  const cols = r.plan.map((c) => c.sqlName);
  const colSql = cols.map(ident).join(', ');
  const updates = cols.filter((c) => c.toLowerCase() !== 'id')
    .map((c) => `${ident(c)} = VALUES(${ident(c)})`).join(', ');
  const placeholders = '(' + cols.map(() => '?').join(', ') + ')';
  for (const rec of records) {
    const row = recordToRow(r.plan, rec);
    const values = cols.map((c) => row[c]);
    await pool.query(
      `INSERT INTO ${ident(r.table)} (${colSql}) VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${updates}`,
      values);
  }
  return records.length;
}

async function deleteRows(name, schema, ids) {
  if (!ids.length) return 0;
  const r = await resolve(name, schema);
  if (!r) throw new Error(`MySQL table for ${name} not available`);
  const idCol = r.plan[0].sqlName; // first physical column is ID
  await pool.query(`DELETE FROM ${ident(r.table)} WHERE ${ident(idCol)} IN (${ids.map(() => '?').join(',')})`, ids);
  return ids.length;
}

module.exports = {
  config, isConfigured, connect, close, hasTable, readTable, upsertRows, deleteRows,
  // exported for tests
  physicalColumns, buildPlan, rowToRecord, recordToRow, uintBitsToFloat, floatToUintBits, isIntSqlType,
};
