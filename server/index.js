// Spell Visual Editor server — zero-dependency Node HTTP server.
// Serves the frontend from /public and a JSON API over the DBC files in /dbc.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store, DBC_DIR } = require('./store');
const { SCHEMAS } = require('./schemas');
const { parseM2 } = require('./m2');
const { bakeM2 } = require('./m2bake');
const { decodeBLP } = require('./blp');
const { buildMpq } = require('./mpqwrite');
const { buildZip } = require('./zipwrite');
const mpq = require('./mpq');
const mysqldb = require('./mysqldb');
const config = require('./config');

// Resolved from config.json (editable in-app via Settings) with env fallback.
let CFG = config.resolve();
const PORT = CFG.port;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Drop extracted MPQ contents (Spells\, Creature\, etc.) here to enable 3D previews.
const GAMEDATA_DIR = CFG.gamedataDir;
// Path to a WoW client's Data folder, so patch exports can drop straight in.
// Mutable: the Settings panel can change it without a restart.
let CLIENT_DIR = CFG.clientDir || '';
// Tables shared with (and written back to) Stoneharry's MySQL when configured.
// The three visual tables plus Spell (for its SpellVisual1/2 pointers).
const MYSQL_TABLES = ['Spell', 'SpellVisual', 'SpellVisualKit', 'SpellVisualEffectName'];
mysqldb.configure(CFG.mysql);

const store = new Store();
store.load();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Resolve a game-data virtual path (e.g. "Spells\\FireBall_Missile.mdx") to a real
// file inside GAMEDATA_DIR, trying .m2/.mdx/.mdl extensions. Rejects path escapes.
function resolveModelPath(virtualPath) {
  const clean = String(virtualPath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.includes('..')) return null;
  const base = clean.replace(/\.(mdx|mdl|m2)$/i, '');
  for (const ext of ['.m2', '.M2', '.mdx', '.MDX', '.mdl']) {
    const p = path.join(GAMEDATA_DIR, base + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

// --- API ---

route('GET', /^\/api\/status$/, (req, res) => {
  sendJson(res, 200, {
    dbcDir: DBC_DIR,
    gamedataDir: GAMEDATA_DIR,
    gamedataPresent: fs.existsSync(GAMEDATA_DIR),
    mpq: mpq.list(),
    dirty: store.dirtyTables(),
    history: store.historyInfo(),
    tables: store.status,
    backend: store.mysqlTables.size ? 'mysql' : 'file',
    mysqlTables: [...store.mysqlTables],
    clientDir: CLIENT_DIR || null,
  });
});

// Current settings for the Settings panel. The MySQL password is never sent to
// the client — only whether one is set.
function publicConfig() {
  return {
    mysql: {
      host: CFG.mysql.host, port: CFG.mysql.port, user: CFG.mysql.user,
      database: CFG.mysql.database,
      // shown in the clear in the Settings form (local tool; the value lives in
      // a gitignored config.json regardless)
      password: CFG.mysql.password,
    },
    clientDir: CFG.clientDir || '',
    gamedataDir: CFG.gamedataDir,
    port: CFG.port,
    configPath: CFG.configPath,
    backend: store.mysqlTables.size ? 'mysql' : 'file',
    mysqlTables: [...store.mysqlTables],
  };
}

// Effective MySQL config from a settings form: blank password means "keep the
// stored one" (the UI never receives it, so it can't send it back).
function effectiveMysql(m = {}) {
  return {
    host: m.host || CFG.mysql.host,
    port: Number(m.port) || CFG.mysql.port,
    user: m.user || CFG.mysql.user,
    password: (m.password !== undefined && m.password !== null) ? m.password : CFG.mysql.password,
    database: (m.database || '').trim(),
  };
}

route('GET', /^\/api\/config$/, (req, res) => sendJson(res, 200, publicConfig()));

// Dry-run a connection with the submitted credentials before saving.
route('POST', /^\/api\/config\/test$/, async (req, res) => {
  const body = await readBody(req);
  const cfg = effectiveMysql(body.mysql);
  if (!cfg.database) return sendJson(res, 200, { ok: false, error: 'No database name given.' });
  try {
    const r = await mysqldb.testConnection(cfg, MYSQL_TABLES, SCHEMAS);
    sendJson(res, 200, r);
  } catch (e) {
    sendJson(res, 200, { ok: false, error: e.message });
  }
});

// Persist settings to config.json, then apply live: reconnect MySQL and reload
// the shared tables, and update the client Data folder — no restart needed.
route('POST', /^\/api\/config$/, async (req, res) => {
  const body = await readBody(req);
  const update = {};
  if (body.mysql) {
    update.mysql = {};
    if (body.mysql.host !== undefined) update.mysql.host = String(body.mysql.host).trim();
    if (body.mysql.user !== undefined) update.mysql.user = String(body.mysql.user).trim();
    if (body.mysql.database !== undefined) update.mysql.database = String(body.mysql.database).trim();
    if (body.mysql.port !== undefined) update.mysql.port = Number(body.mysql.port) || 3306;
    // the form always sends the current password (shown in the clear), so take
    // it as-is — including empty, which clears it
    if (body.mysql.password !== undefined && body.mysql.password !== null) {
      update.mysql.password = String(body.mysql.password);
    }
  }
  if (body.clientDir !== undefined) update.clientDir = String(body.clientDir).trim();
  try {
    CFG = config.save(update);
    CLIENT_DIR = CFG.clientDir || '';
    mysqldb.configure(CFG.mysql);
    await reloadMysqlTables();
    sendJson(res, 200, { ok: true, ...publicConfig() });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
});

route('POST', /^\/api\/(undo|redo)$/, (req, res, m) => {
  const entry = m[1] === 'undo' ? store.undo() : store.redo();
  if (!entry) return sendJson(res, 404, { error: `nothing to ${m[1]}` });
  sendJson(res, 200, {
    label: entry.label,
    tables: [...new Set(entry.ops.map((o) => o.table))],
    history: store.historyInfo(),
  });
});

route('GET', /^\/api\/schema\/(\w+)$/, (req, res, m) => {
  const schema = SCHEMAS[m[1]];
  if (!schema) return sendJson(res, 404, { error: `unknown table ${m[1]}` });
  sendJson(res, 200, { name: m[1], fields: schema });
});

// Full table dump (used for the small reference tables and pickers).
route('GET', /^\/api\/table\/(\w+)$/, (req, res, m, url) => {
  const t = store.get(m[1]);
  if (!t) return sendJson(res, 404, { error: `table ${m[1]} not loaded`, status: store.status[m[1]] || null });
  sendJson(res, 200, { name: m[1], records: t.records });
});

route('GET', /^\/api\/table\/(\w+)\/(-?\d+)$/, (req, res, m) => {
  const rec = store.getRecord(m[1], Number(m[2]));
  if (!rec) return sendJson(res, 404, { error: `${m[1]} #${m[2]} not found` });
  sendJson(res, 200, rec);
});

route('PUT', /^\/api\/table\/(\w+)\/(-?\d+)$/, async (req, res, m) => {
  const body = await readBody(req);
  const rec = store.updateRecord(m[1], Number(m[2]), body);
  sendJson(res, 200, rec);
});

route('POST', /^\/api\/table\/(\w+)$/, async (req, res, m) => {
  const body = await readBody(req);
  const rec = store.createRecord(m[1], { id: body.id, cloneFrom: body.cloneFrom });
  sendJson(res, 201, rec);
});

route('DELETE', /^\/api\/table\/(\w+)\/(-?\d+)$/, (req, res, m) => {
  store.deleteRecord(m[1], Number(m[2]));
  sendJson(res, 200, { ok: true });
});

// Spell search: server-side because Spell.dbc has ~50k rows.
route('GET', /^\/api\/spells$/, (req, res, m, url) => {
  const t = store.get('Spell');
  if (!t) {
    return sendJson(res, 503, {
      error: 'Spell.dbc is not loaded',
      status: store.status.Spell || null,
    });
  }
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const offset = Number(url.searchParams.get('offset')) || 0;
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
  const visual = url.searchParams.has('visual') ? Number(url.searchParams.get('visual')) : null;
  const isNum = /^\d+$/.test(q);
  const matches = [];
  for (const r of t.records) {
    if (visual != null && r.SpellVisualID[0] !== visual && r.SpellVisualID[1] !== visual) continue;
    if (q) {
      const name = (r.Name.enUS || '').toLowerCase();
      if (isNum) {
        if (r.ID !== Number(q) && !name.includes(q)) continue;
      } else if (!name.includes(q)) continue;
    }
    matches.push(r);
  }
  const page = matches.slice(offset, offset + limit).map((r) => ({
    ID: r.ID,
    name: r.Name.enUS,
    rank: r.NameSubtext.enUS,
    icon: r.SpellIconID,
    visual: r.SpellVisualID,
  }));
  sendJson(res, 200, { total: matches.length, offset, records: page });
});

// Deep-clone a spell visual chain: visual + kits (+ effects), all rewired.
route('POST', /^\/api\/clone-visual-chain$/, async (req, res) => {
  const body = await readBody(req);
  const visualId = Number(body.visualId);
  if (!visualId) return sendJson(res, 400, { error: 'visualId required' });
  const result = store.cloneVisualChain(visualId, {
    cloneEffects: body.cloneEffects !== false,
    spellId: body.spellId != null ? Number(body.spellId) : null,
    spellSlot: Number(body.spellSlot) || 0,
  });
  sendJson(res, 200, result);
});

route('POST', /^\/api\/save$/, async (req, res) => {
  // MySQL-backed tables flush to the shared database; everything else to dbc/.
  let mysql = null;
  if (store.mysqlTables.size) {
    try { mysql = await store.saveToMysql(mysqldb); }
    catch (e) { return sendJson(res, 500, { error: `MySQL save failed: ${e.message}` }); }
  }
  const result = store.save();
  sendJson(res, 200, { ...result, mysql });
});

// Any table missing from dbc/ is filled from the client's archives — this is
// how AnimationData/SoundEntries names light up without manual exports.
function loadTablesFromArchives() {
  for (const name of Object.keys(SCHEMAS)) {
    if (store.status[name] && store.status[name].state === 'ok') continue;
    const hit = mpq.readFile(`DBFilesClient\\${name}.dbc`);
    if (!hit) continue;
    try {
      store.loadFromBuffer(name, hit.data, hit.archive);
    } catch (e) { /* keep the original missing/error status */ }
  }
}

// Discard in-memory edits: reload the named tables (or all dirty ones) from
// disk, falling back to the MPQ chain for archive-sourced tables.
route('POST', /^\/api\/discard$/, async (req, res) => {
  const body = await readBody(req);
  const targets = body.all ? store.dirtyTables()
    : Array.isArray(body.tables) ? body.tables.filter((n) => /^\w+$/.test(n)) : [];
  const discarded = [], failed = [];
  for (const name of targets) {
    try {
      if (store.mysqlTables.has(name)) {
        await store.loadFromMysql(mysqldb, [name]);
        discarded.push(name);
        continue;
      }
      if (store.reloadTable(name)) { discarded.push(name); continue; }
      const hit = mpq.readFile(`DBFilesClient\\${name}.dbc`);
      if (hit) {
        store.loadFromBuffer(name, hit.data, hit.archive);
        discarded.push(name);
      } else {
        failed.push({ name, error: 'no disk file or archive copy to reload from' });
      }
    } catch (e) {
      failed.push({ name, error: e.message });
    }
  }
  sendJson(res, 200, { discarded, failed, dirty: store.dirtyTables() });
});

route('POST', /^\/api\/reload$/, async (req, res) => {
  store.tables = {};
  store.status = {};
  store.mysqlTables = new Set();
  store.load();
  await mpq.init(GAMEDATA_DIR);
  loadTablesFromArchives();
  await loadFromMysql();
  sendJson(res, 200, { ok: true, tables: store.status, mpq: mpq.list(), backend: store.mysqlTables.size ? 'mysql' : 'file' });
});

// Audition a SoundEntries record: serves one of its files from the archives.
route('GET', /^\/api\/sound\/(\d+)$/, (req, res, m) => {
  const rec = store.getRecord('SoundEntries', Number(m[1]));
  if (!rec) return sendJson(res, 404, { error: `SoundEntries #${m[1]} not loaded/found` });
  const files = rec.File.filter(Boolean);
  if (!files.length) return sendJson(res, 404, { error: 'sound entry has no files' });
  const pick = files[Math.floor(Math.random() * files.length)];
  const vpath = rec.DirectoryBase ? `${rec.DirectoryBase.replace(/[\\/]+$/, '')}\\${pick}` : pick;
  const hit = readGameFile(vpath);
  if (!hit) return sendJson(res, 404, { error: `sound file not found: ${vpath}` });
  const type = /\.mp3$/i.test(pick) ? 'audio/mpeg' : 'audio/wav';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(hit.data.length), 'Cache-Control': 'max-age=300' });
  res.end(hit.data);
});

// Models leave "replaceable" texture slots empty for the client to fill:
//  - creatures (type 11+) via CreatureDisplayInfo
//  - player characters (type 1 body / 6 hair) via a CharSections composite
// We approximate both from BLPs in the model's own folder so previews aren't
// blank-white. Character bodies use the full-body skin atlas (…Skin00_00.blp).
function resolveModelSkins(geom, vpath) {
  if (!geom.textures) return;
  const needCreature = geom.textures.some((t) => t.type >= 11 && !t.fileName);
  const needChar = geom.textures.some((t) => (t.type === 1 || t.type === 6) && !t.fileName);
  // a body/hair composite slot is what makes this a player-character model —
  // the viewer needs to know, because their geosets follow the equipment
  // convention (see visibleGeosets in viewer.js)
  geom.isCharacter = needChar;
  if (!needCreature && !needChar) return;

  const clean = String(vpath).replace(/\//g, '\\');
  const dir = clean.replace(/\\[^\\]*$/, '');
  const modelBase = clean.replace(/^.*\\/, '').replace(/\.(m2|mdx|mdl)$/i, '');
  const blps = mpq.blpsInDir(dir).map((f) => f.path).sort();
  if (!blps.length) return;

  // full-body skin: <ModelName>Skin00_00.blp, else first non-region *Skin00_00
  const bodySkin = blps.find((b) => b.toLowerCase().endsWith(`${modelBase}skin00_00.blp`))
    || blps.find((b) => /skin00_00\.blp$/i.test(b) && !/naked|face|extra|scalp|hair|underwear/i.test(b));
  // Hair lives one level up, in the race folder (Character\Human\Hair00_00.blp)
  // rather than beside the model, so search the parent too or the hair geoset
  // renders untextured. Hair00_00 is the hair mesh's own texture; the
  // ScalpLowerHair variant is the scalp patch and is only a fallback.
  const parentDir = dir.replace(/\\[^\\]*$/, '');
  const hairPool = parentDir && parentDir !== dir
    ? blps.concat(mpq.blpsInDir(parentDir).map((f) => f.path)).sort()
    : blps;
  const hairTex = hairPool.find((b) => /\\hair00_00\.blp$/i.test(b))
    || hairPool.find((b) => /scalplowerhair00_00\.blp$/i.test(b));

  let ci = 0;
  for (const t of geom.textures) {
    if (t.fileName) continue;
    if (t.type === 1 && bodySkin) t.fileName = bodySkin;
    else if (t.type === 6 && hairTex) t.fileName = hairTex;
    else if (t.type >= 11) { t.fileName = blps[Math.min(ci, blps.length - 1)]; ci++; }
  }
}

// 3D preview geometry for a model referenced by SpellVisualEffectName.FileName.
// Resolution order: loose file under gamedata/ (extracted overrides), then the
// MPQ archive chain (patch-2 > patch > base), trying .m2/.mdx/.mdl variants.
route('GET', /^\/api\/model$/, (req, res, m, url) => {
  const vpath = url.searchParams.get('path');
  if (!vpath) return sendJson(res, 400, { error: 'missing ?path=' });
  const { archives } = mpq.list();
  if (!fs.existsSync(GAMEDATA_DIR)) {
    return sendJson(res, 404, {
      error: 'no gamedata directory',
      hint: `Create ${GAMEDATA_DIR} and drop your 1.12.1 client MPQs there (model.MPQ, patch.MPQ, patch-2.MPQ — or the whole Data folder / extracted files) to enable 3D previews.`,
    });
  }
  const file = resolveModelPath(vpath);
  if (file) {
    try {
      const geom = parseM2(fs.readFileSync(file));
      resolveModelSkins(geom, vpath);
      return sendJson(res, 200, { file: path.relative(GAMEDATA_DIR, file), ...geom });
    } catch (e) {
      return sendJson(res, 422, { error: `failed to parse ${path.basename(file)}: ${e.message}` });
    }
  }
  // archive chain
  const clean = String(vpath).replace(/\//g, '\\').replace(/^\\+/, '');
  const base = clean.replace(/\.(mdx|mdl|m2)$/i, '');
  for (const ext of ['.m2', '.mdx', '.mdl']) {
    const hit = mpq.readFile(base + ext);
    if (!hit) continue;
    try {
      const geom = parseM2(hit.data);
      resolveModelSkins(geom, base + ext);
      return sendJson(res, 200, { file: `${hit.archive}:${base + ext}`, ...geom });
    } catch (e) {
      return sendJson(res, 422, { error: `failed to parse ${base + ext} from ${hit.archive}: ${e.message}` });
    }
  }
  if (!archives.length) {
    return sendJson(res, 404, {
      error: `model not found: ${vpath}`,
      hint: `No MPQ archives or extracted model files found in ${GAMEDATA_DIR}. Drop your client's model.MPQ / patch.MPQ / patch-2.MPQ there (or the whole Data folder).`,
    });
  }
  sendJson(res, 404, { error: `model not found in ${archives.length} archive(s) or loose files: ${vpath}`, archives });
});

function readRawBody(req, maxBytes = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// All loose (non-archive) files under gamedata, with virtual paths.
function listLooseFiles() {
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = fs.statSync(full);
      const vname = rel ? `${rel}\\${entry}` : entry;
      if (st.isDirectory()) {
        if (entry.toLowerCase() === 'data') continue;
        walk(full, vname);
      } else if (!/\.mpq$/i.test(entry)) {
        files.push({ path: vname, size: st.size, full });
      }
    }
  };
  if (fs.existsSync(GAMEDATA_DIR)) walk(GAMEDATA_DIR, '');
  return files;
}

function sendDownload(res, filename, data) {
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    'Content-Length': String(data.length),
  });
  res.end(data);
}

// --- export / import ---

// Current in-memory state of one table as a .dbc download (disk untouched).
route('GET', /^\/api\/export\/dbc\/(\w+)$/, (req, res, m) => {
  const buf = store.serializeTable(m[1]);
  sendDownload(res, `${m[1]}.dbc`, buf);
});

// Loose custom files (baked models etc.) for the export dialog.
route('GET', /^\/api\/loose-files$/, (req, res) => {
  sendJson(res, 200, { files: listLooseFiles().map(({ path: p, size }) => ({ path: p, size })) });
});

route('GET', /^\/api\/export\/file$/, (req, res, m, url) => {
  const vpath = String(url.searchParams.get('path') || '').replace(/\\/g, '/');
  if (!vpath || vpath.includes('..')) return sendJson(res, 400, { error: 'bad path' });
  const full = path.join(GAMEDATA_DIR, vpath);
  if (!full.startsWith(path.resolve(GAMEDATA_DIR)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return sendJson(res, 404, { error: `not found: ${vpath}` });
  }
  sendDownload(res, path.basename(full), fs.readFileSync(full));
});

// ZIP bundle: ?dbc=Name1,Name2 (or "dirty") under DBFilesClient/, ?files=all
// for every loose gamedata file with folder structure preserved.
route('GET', /^\/api\/export\/zip$/, (req, res, m, url) => {
  const entries = [];
  const dbcParam = url.searchParams.get('dbc') || '';
  const names = dbcParam === 'dirty' ? store.dirtyTables()
    : dbcParam ? dbcParam.split(',').filter((n) => /^\w+$/.test(n)) : [];
  for (const name of names) {
    entries.push({ name: `DBFilesClient/${name}.dbc`, data: store.serializeTable(name) });
  }
  if (url.searchParams.get('files') === 'all') {
    for (const f of listLooseFiles()) {
      entries.push({ name: f.path.replace(/\\/g, '/'), data: fs.readFileSync(f.full) });
    }
  }
  if (!entries.length) return sendJson(res, 404, { error: 'nothing selected to export' });
  const stamp = new Date().toISOString().slice(0, 10);
  sendDownload(res, `spell-visual-export-${stamp}.zip`, buildZip(entries));
});

// Upload a .dbc: validated against the 1.12.1 schema, existing file backed up,
// then installed and reloaded.
route('POST', /^\/api\/import\/dbc$/, async (req, res, m, url) => {
  const name = String(url.searchParams.get('name') || '');
  if (!/^\w+$/.test(name)) return sendJson(res, 400, { error: 'bad table name' });
  const buf = await readRawBody(req);
  if (!buf.length) return sendJson(res, 400, { error: 'empty upload' });
  const result = store.importTable(name, buf);
  sendJson(res, 200, { ok: true, table: name, ...result });
});

// Read any game file: loose file under gamedata first, then the MPQ chain.
function readGameFile(vpath) {
  const clean = String(vpath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.includes('..')) return null;
  const loose = path.join(GAMEDATA_DIR, clean);
  if (fs.existsSync(loose) && fs.statSync(loose).isFile()) {
    return { source: 'loose', data: fs.readFileSync(loose) };
  }
  const hit = mpq.readFile(vpath);
  return hit ? { source: hit.archive, data: hit.data } : null;
}

// Bake a transform into a copy of an M2 and write it as a loose file under
// gamedata/ (from where the editor resolves it immediately; pack it into a
// patch MPQ for the client via /api/export-patch).
route('POST', /^\/api\/bake-m2$/, async (req, res) => {
  const body = await readBody(req);
  const { sourcePath, outPath } = body;
  if (!sourcePath || !outPath) return sendJson(res, 400, { error: 'sourcePath and outPath required' });
  const cleanOut = String(outPath).replace(/\//g, '\\').replace(/^\\+/, '');
  if (cleanOut.includes('..') || !/\.m2$/i.test(cleanOut)) {
    return sendJson(res, 400, { error: 'outPath must be a relative path ending in .m2' });
  }
  // resolve source with model extension fallbacks
  const base = String(sourcePath).replace(/\.(mdx|mdl|m2)$/i, '');
  let src = null;
  for (const ext of ['.m2', '.mdx', '.mdl']) {
    src = readGameFile(base + ext);
    if (src) break;
  }
  if (!src) return sendJson(res, 404, { error: `source model not found: ${sourcePath}` });
  const baked = bakeM2(src.data, {
    offset: (body.offset || [0, 0, 0]).map(Number),
    yaw: Number(body.yaw) || 0,
    pitch: Number(body.pitch) || 0,
    roll: Number(body.roll) || 0,
    scale: Number(body.scale) || 1,
  });
  const outFile = path.join(GAMEDATA_DIR, cleanOut.replace(/\\/g, '/'));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, baked);
  sendJson(res, 200, { outPath: cleanOut, bytes: baked.length, source: src.source });
});

// Collect loose gamedata files (+ optionally the in-memory DBCs) for a patch.
function buildPatchFiles(includeDbc) {
  const files = listLooseFiles()
    .filter((f) => f.size < 100 * 1024 * 1024)
    .map((f) => ({ name: f.path, data: fs.readFileSync(f.full) }));
  if (includeDbc) {
    for (const name of Object.keys(store.tables)) {
      files.push({ name: `DBFilesClient\\${name}.dbc`, data: store.serializeTable(name) });
    }
  }
  return files;
}

// The next patch archive name that would OUTRANK everything already in `dir`.
// Client load order: base < patch < patch-2..9 < patch-A..Z (higher wins). We
// return the next free letter above the highest present — so the export is the
// one the client actually loads, instead of the old hardcoded patch-3.MPQ that
// silently lost to any patch-4/A..Z already installed.
function nextPatchName(dir) {
  let maxLetter = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const mm = f.toLowerCase().match(/^patch-([a-z])\.mpq$/);
      if (mm) maxLetter = Math.max(maxLetter, mm[1].charCodeAt(0) - 96); // a=1
    }
  } catch (e) { /* dir missing — start at A */ }
  const next = Math.min(maxLetter + 1, 26);
  return `patch-${String.fromCharCode(64 + next)}.MPQ`; // A..Z, above all numbered patches
}

// Download a patch archive (loose files + optionally the DBCs). ?dbc=1 embeds
// the current in-memory DBCs under DBFilesClient\. Filename is the next winning
// patch letter for wherever you'll drop it (client dir if configured).
route('GET', /^\/api\/export-patch$/, (req, res, m, url) => {
  const files = buildPatchFiles(url.searchParams.get('dbc') === '1');
  if (!files.length) return sendJson(res, 404, { error: 'no loose files under gamedata to pack' });
  const name = nextPatchName(CLIENT_DIR || GAMEDATA_DIR);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${name}"`,
    'X-File-Count': String(files.length),
  });
  res.end(buildMpq(files));
});

// Write the patch straight into the configured WoW client Data folder, so you
// skip the download-and-move step. Defaults to embedding the DBCs and to the
// next winning patch letter; ?name=patch-X.MPQ overrides (e.g. to keep updating
// one managed patch). Never touches archives you maintain by hand.
route('POST', /^\/api\/deploy-patch$/, async (req, res) => {
  if (!CLIENT_DIR) return sendJson(res, 400, { error: 'CLIENT_DIR is not set — start the server with CLIENT_DIR pointed at your WoW Data folder to enable deploy.' });
  if (!fs.existsSync(CLIENT_DIR) || !fs.statSync(CLIENT_DIR).isDirectory()) {
    return sendJson(res, 400, { error: `CLIENT_DIR is not a directory: ${CLIENT_DIR}` });
  }
  const body = await readBody(req);
  const includeDbc = body.dbc !== false;
  const files = buildPatchFiles(includeDbc);
  if (!files.length) return sendJson(res, 404, { error: 'nothing to pack (no loose files or DBC tables)' });
  let name = nextPatchName(CLIENT_DIR);
  if (body.name) {
    if (!/^patch-[0-9a-z]\.mpq$/i.test(String(body.name))) {
      return sendJson(res, 400, { error: 'name must look like patch-X.MPQ' });
    }
    name = String(body.name);
  }
  const dest = path.join(CLIENT_DIR, name);
  if (!path.resolve(dest).startsWith(path.resolve(CLIENT_DIR))) {
    return sendJson(res, 400, { error: 'bad name' });
  }
  fs.writeFileSync(dest, buildMpq(files));
  sendJson(res, 200, { written: dest, name, files: files.length, includedDbc: includeDbc });
});

// Browse every model available to the client: loose files under gamedata plus
// all models enumerated from the MPQ archive chain (via their listfiles).
route('GET', /^\/api\/models$/, (req, res, m, url) => {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const dir = (url.searchParams.get('dir') || '').toLowerCase();
  const offset = Number(url.searchParams.get('offset')) || 0;
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);

  // loose files take resolution priority — list them first
  const loose = [];
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d)) {
      const full = path.join(d, entry);
      const st = fs.statSync(full);
      const vname = rel ? `${rel}\\${entry}` : entry;
      if (st.isDirectory()) {
        if (entry.toLowerCase() === 'data') continue;
        walk(full, vname);
      } else if (/\.(m2|mdx|mdl)$/i.test(entry)) {
        loose.push({ path: vname, archive: 'loose file', size: st.size });
      }
    }
  };
  if (fs.existsSync(GAMEDATA_DIR)) walk(GAMEDATA_DIR, '');
  const looseKeys = new Set(loose.map((f) => f.path.toLowerCase()));
  const all = [...loose, ...mpq.listModels().filter((f) => !looseKeys.has(f.path.toLowerCase()))];

  // top-level folder facets over the full set
  const dirCounts = new Map();
  for (const f of all) {
    const top = f.path.split('\\')[0].toLowerCase();
    dirCounts.set(top, (dirCounts.get(top) || 0) + 1);
  }
  const dirs = [...dirCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const matches = all.filter((f) => {
    const p = f.path.toLowerCase();
    if (dir && !p.startsWith(dir + '\\')) return false;
    if (q && !p.includes(q)) return false;
    return true;
  });
  sendJson(res, 200, {
    total: matches.length,
    offset,
    dirs,
    records: matches.slice(offset, offset + limit),
  });
});

// Spell icon as PNG (SpellIcon.dbc -> BLP from archives), cached.
const { encodePNG } = require('./png');
const iconCache = new Map();
route('GET', /^\/api\/icon\/(\d+)$/, (req, res, m) => {
  const id = Number(m[1]);
  if (iconCache.has(id)) {
    const png = iconCache.get(id);
    if (!png) return sendJson(res, 404, { error: 'icon unavailable' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
    return res.end(png);
  }
  const rec = store.getRecord('SpellIcon', id);
  const vpath = rec && rec.TextureFilename ? rec.TextureFilename.replace(/\.blp$/i, '') + '.blp' : null;
  const hit = vpath ? readGameFile(vpath) : null;
  if (!hit) { iconCache.set(id, null); return sendJson(res, 404, { error: `icon #${id} not found` }); }
  try {
    const img = decodeBLP(hit.data);
    const png = encodePNG(img.width, img.height, img.rgba);
    iconCache.set(id, png);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
    res.end(png);
  } catch (e) {
    iconCache.set(id, null);
    sendJson(res, 422, { error: e.message });
  }
});

// Decoded BLP texture as raw RGBA bytes (dimensions in headers).
route('GET', /^\/api\/texture$/, (req, res, m, url) => {
  const vpath = url.searchParams.get('path');
  if (!vpath) return sendJson(res, 400, { error: 'missing ?path=' });
  const clean = String(vpath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.includes('..')) return sendJson(res, 400, { error: 'bad path' });
  let data = null;
  const loose = path.join(GAMEDATA_DIR, clean);
  if (fs.existsSync(loose) && fs.statSync(loose).isFile()) data = fs.readFileSync(loose);
  if (!data) {
    const hit = mpq.readFile(vpath);
    if (hit) data = hit.data;
  }
  if (!data) return sendJson(res, 404, { error: `texture not found: ${vpath}` });
  try {
    const img = decodeBLP(data);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'X-Width': String(img.width),
      'X-Height': String(img.height),
      'Cache-Control': 'max-age=300',
    });
    res.end(Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength));
  } catch (e) {
    sendJson(res, 422, { error: `failed to decode ${vpath}: ${e.message}` });
  }
});

// --- static files ---
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  // No validators here meant browsers fell back to heuristic caching and could
  // serve a stale app.js/viewer.js after an edit — with no way to tell from the
  // page. It's a localhost tool serving a few small files, so never cache.
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store, must-revalidate',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (m) return await r.handler(req, res, m, url);
    }
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
});

// When paired with Stoneharry's MySQL, override the shared tables with the
// database copy so it becomes the single source of truth. Non-fatal: any
// failure logs and leaves the file/archive data in place.
async function loadFromMysql() {
  if (!mysqldb.isConfigured()) return;
  try {
    await mysqldb.connect();
    const loaded = await store.loadFromMysql(mysqldb, MYSQL_TABLES);
    const cfg = mysqldb.getConfig();
    console.log(`  MySQL: ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database} — ` +
      (loaded.length ? `backing ${loaded.join(', ')}` : 'connected, but no matching tables found'));
  } catch (e) {
    console.log(`  !! MySQL disabled: ${e.message}`);
  }
}

// Reload just the MySQL-backed tables from the database (or clear them back to
// file/archive if MySQL was turned off). Used after Settings changes.
async function reloadMysqlTables() {
  // drop any previously MySQL-sourced tables so they can revert to file/archive
  for (const name of [...store.mysqlTables]) store.mysqlTables.delete(name);
  store.tables = {};
  store.status = {};
  store.load();
  loadTablesFromArchives();
  await loadFromMysql();
}

async function main() {
  try {
    await mpq.init(GAMEDATA_DIR);
    loadTablesFromArchives();
  } catch (e) {
    console.log(`  !! MPQ init failed: ${e.message}`);
  }
  await loadFromMysql();
  server.listen(PORT, () => {
    const s = store.status;
    const ok = Object.keys(s).filter((n) => s[n].state === 'ok');
    const bad = Object.keys(s).filter((n) => s[n].state === 'error');
    console.log(`Spell Visual Editor: http://localhost:${PORT}`);
    console.log(`  DBC dir: ${DBC_DIR}`);
    console.log(`  Loaded ${ok.length} tables: ${ok.join(', ')}`);
    if (bad.length) for (const n of bad) console.log(`  !! ${n}: ${s[n].error}`);
    const { archives, errors } = mpq.list();
    if (archives.length) console.log(`  MPQ archives: ${archives.join(', ')}`);
    for (const e of errors) console.log(`  !! MPQ ${e.name}: ${e.error}`);
    if (!archives.length && !fs.existsSync(GAMEDATA_DIR)) {
      console.log(`  (no ${GAMEDATA_DIR} — drop client MPQs or extracted models there for 3D previews)`);
    }
  });
}

main();
