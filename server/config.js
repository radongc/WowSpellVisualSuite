// App configuration, persisted to config.json at the repo root and editable
// in-app via the Settings panel. Environment variables still work as a fallback
// (handy for CI or a quick one-off), but the file is authoritative when it sets
// a value — so what you save in the UI is what runs. config.json is gitignored;
// your MySQL password never enters the repo.
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.SVS_CONFIG || path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  port: 3414,
  gamedataDir: path.join(__dirname, '..', 'gamedata'),
  clientDir: '',
  mysql: { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '' },
};

function readFile() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { return {}; }
}

// treat undefined / '' as "not set" for strings; NaN as "not set" for numbers
const str = (v) => (v === undefined || v === null || v === '' ? undefined : String(v));
const num = (v) => { const n = Number(v); return (v === undefined || v === null || v === '' || Number.isNaN(n)) ? undefined : n; };
const pick = (...vals) => { for (const v of vals) if (v !== undefined) return v; };

// Resolve effective config: file value wins, then env, then default.
function resolve() {
  const f = readFile();
  const fm = f.mysql || {};
  const e = process.env;
  return {
    port: pick(num(f.port), num(e.PORT), DEFAULTS.port),
    gamedataDir: pick(str(f.gamedataDir), str(e.GAMEDATA_DIR), DEFAULTS.gamedataDir),
    clientDir: pick(str(f.clientDir), str(e.CLIENT_DIR), '') || '',
    mysql: {
      host: pick(str(fm.host), str(e.MYSQL_HOST), DEFAULTS.mysql.host),
      port: pick(num(fm.port), num(e.MYSQL_PORT), DEFAULTS.mysql.port),
      user: pick(str(fm.user), str(e.MYSQL_USER), DEFAULTS.mysql.user),
      // password may legitimately be empty, so keep an explicit value if present
      password: fm.password !== undefined ? String(fm.password)
        : (e.MYSQL_PASSWORD !== undefined ? e.MYSQL_PASSWORD : ''),
      database: pick(str(fm.database), str(e.MYSQL_DATABASE), '') || '',
    },
    configPath: CONFIG_PATH,
  };
}

// Merge an update into config.json and write it back (pretty-printed). Nested
// mysql is shallow-merged so omitting a field (e.g. password) preserves it.
function save(update) {
  const cur = readFile();
  const next = { ...cur, ...update };
  if (update && update.mysql) next.mysql = { ...(cur.mysql || {}), ...update.mysql };
  delete next.configPath;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
  return resolve();
}

module.exports = { resolve, save, CONFIG_PATH, DEFAULTS };
