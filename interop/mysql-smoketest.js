// Live smoke test for the MySQL backend. Verifies the connection + SQL layer
// against a REAL MySQL/MariaDB server, using a throwaway table it creates and
// drops itself — it never touches your real spellvisual/spell tables.
//
// Usage (same env vars as the server):
//   MYSQL_HOST=127.0.0.1 MYSQL_USER=root MYSQL_PASSWORD=... MYSQL_DATABASE=test \
//     node interop/mysql-smoketest.js
//
// Requires: npm install mysql2
//
// It builds a table with Stoneharry's (TBC-shifted, mislabeled) SpellVisual
// column layout, inserts a genuine vanilla row, then drives it through the
// suite's own mysqldb module to prove that positional mapping recovers the
// correct vanilla fields and round-trips an edit.

const path = require('path');
const mysqldb = require(path.join(__dirname, '..', 'server', 'mysqldb'));
const { SCHEMAS } = require(path.join(__dirname, '..', 'server', 'schemas'));

const TABLE = 'zz_svs_smoketest'; // unusual name; created and dropped here only

// Stoneharry's SpellVisual columns, in binding order (all integer-typed).
const COLS = ['ID', 'PrecastKit', 'CastKit', 'ImpactKit', 'StateKit', 'StateDoneKit',
  'ChannelKit', 'HasMissile', 'MissileModel', 'MissilePathType', 'MissileDestinationAttachment',
  'MissileSound', 'AnimEventSoundId', 'Flags', 'CasterImpactKit', 'TargetImpactKit'];
// A real vanilla row (visual #7893: arc Frostbolt), values in ordinal/byte order.
const VANILLA = [7893, 6759, 6760, 6761, 6762, 0, 1, 3073, 2, 1, 3013, 0, 0, 0, 0, 1];

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'ok  ' : 'FAIL') + ' : ' + msg); if (!c) fails++; };

async function main() {
  if (!mysqldb.isConfigured()) {
    console.error('Set MYSQL_DATABASE (and host/user/password) first.');
    process.exit(2);
  }
  let driver;
  try { driver = require('mysql2/promise'); }
  catch (e) { console.error('Run `npm install mysql2` first.'); process.exit(2); }

  const cfg = mysqldb.config();
  const conn = await driver.createConnection(cfg);
  console.log(`connected: ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}\n`);

  try {
    await conn.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
    await conn.query(`CREATE TABLE \`${TABLE}\` (${COLS.map((c) => `\`${c}\` INT`).join(', ')}, PRIMARY KEY (\`ID\`))`);
    await conn.query(`INSERT INTO \`${TABLE}\` (${COLS.map((c) => `\`${c}\``).join(',')}) VALUES (${VANILLA.join(',')})`);

    // Point the module at our throwaway table by temporarily aliasing the schema name.
    // We call the module's low-level query helpers via a tiny shim: reuse its pool.
    await mysqldb.connect();
    // Introspect + map exactly as the server would, but against our test table.
    const [dbCols] = await queryCols(conn, cfg.database, TABLE);
    const plan = mysqldb.buildPlan(SCHEMAS.SpellVisual, dbCols, TABLE);
    const [rows] = await conn.query(`SELECT * FROM \`${TABLE}\``);
    const rec = mysqldb.rowToRecord(plan, rows[0]);

    ok(rec.MissileModel === 3073, `read MissileModel = 3073 (got ${rec.MissileModel})`);
    ok(rec.MissilePathType === 2, `read MissilePathType = 2 (got ${rec.MissilePathType})`);
    ok(rec.HasMissile === 1, `read HasMissile = 1 (got ${rec.HasMissile})`);
    ok(rec.MissileAttachment === 1, `read MissileAttachment = 1 (got ${rec.MissileAttachment})`);

    // Edit here, write back positionally, re-read raw, confirm byte offset 8 changed.
    rec.MissilePathType = 0; // "straighten" the missile
    const row = mysqldb.recordToRow(plan, rec);
    const setSql = plan.map((c) => `\`${c.sqlName}\` = ?`).join(', ');
    await conn.query(`UPDATE \`${TABLE}\` SET ${setSql} WHERE \`ID\` = ?`,
      [...plan.map((c) => row[c.sqlName]), 7893]);
    const [after] = await conn.query(`SELECT \`MissileModel\` AS ord8 FROM \`${TABLE}\` WHERE ID=7893`);
    // this suite's MissilePathType is ordinal 8 -> Stoneharry's 'MissileModel' column
    ok(after[0].ord8 === 0, `write-back put pathType=0 at byte offset 8 (Stoneharry 'MissileModel' col = ${after[0].ord8})`);

    const [rows2] = await conn.query(`SELECT * FROM \`${TABLE}\``);
    const rec2 = mysqldb.rowToRecord(plan, rows2[0]);
    ok(rec2.MissilePathType === 0 && rec2.MissileModel === 3073,
      `re-read: pathType=0, MissileModel still 3073 (got ${rec2.MissilePathType}, ${rec2.MissileModel})`);
  } finally {
    await conn.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
    await conn.end();
    await mysqldb.close();
  }

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS — live MySQL round-trip works.');
  process.exit(fails ? 1 : 0);
}

function queryCols(conn, db, table) {
  return conn.query(
    'SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType FROM INFORMATION_SCHEMA.COLUMNS ' +
    'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [db, table]);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
