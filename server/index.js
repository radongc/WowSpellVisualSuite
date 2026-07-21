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
const mpq = require('./mpq');

const PORT = Number(process.env.PORT) || 3414;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Drop extracted MPQ contents (Spells\, Creature\, etc.) here to enable 3D previews.
const GAMEDATA_DIR = process.env.GAMEDATA_DIR || path.join(__dirname, '..', 'gamedata');

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
    tables: store.status,
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

route('POST', /^\/api\/save$/, (req, res) => {
  const result = store.save();
  sendJson(res, 200, result);
});

route('POST', /^\/api\/reload$/, async (req, res) => {
  store.tables = {};
  store.status = {};
  store.load();
  await mpq.init(GAMEDATA_DIR);
  sendJson(res, 200, { ok: true, tables: store.status, mpq: mpq.list() });
});

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

// Pack all loose files under gamedata/ (excluding .MPQ archives) into a fresh
// patch archive the 1.12 client can load.
route('GET', /^\/api\/export-patch$/, (req, res) => {
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const vname = rel ? `${rel}\\${entry}` : entry;
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        if (entry.toLowerCase() === 'data') continue; // nested archive dir
        walk(full, vname);
      } else if (!/\.mpq$/i.test(entry) && st.size < 100 * 1024 * 1024) {
        files.push({ name: vname, data: fs.readFileSync(full) });
      }
    }
  };
  if (fs.existsSync(GAMEDATA_DIR)) walk(GAMEDATA_DIR, '');
  if (!files.length) return sendJson(res, 404, { error: 'no loose files under gamedata to pack' });
  const archive = buildMpq(files);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="patch-3.MPQ"',
    'X-File-Count': String(files.length),
  });
  res.end(archive);
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
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
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

async function main() {
  try {
    await mpq.init(GAMEDATA_DIR);
  } catch (e) {
    console.log(`  !! MPQ init failed: ${e.message}`);
  }
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
