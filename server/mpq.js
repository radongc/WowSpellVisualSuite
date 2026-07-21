// MPQ archive support: read game files straight from client .MPQ archives placed
// in the gamedata dir (or its Data/ subdir — pointing GAMEDATA_DIR at a WoW
// install root works too). Uses StormLib compiled to WASM (@wowserhq/stormjs).
const fs = require('fs');
const path = require('path');

let storm = null;                 // lazy-loaded stormjs module
const mounts = new Map();         // real dir -> emscripten mount point
let archives = [];                // [{ name, mpq }] in lookup priority order
let errors = [];                  // [{ name, error }]

function loadStorm() {
  if (!storm) storm = require('@wowserhq/stormjs');
  return storm;
}

function mountDir(dir) {
  const { FS } = loadStorm();
  const key = path.resolve(dir).toLowerCase();
  if (mounts.has(key)) return mounts.get(key);
  const point = `/gd${mounts.size}`;
  FS.mkdir(point);
  FS.mount(FS.filesystems.NODEFS, { root: dir }, point);
  mounts.set(key, point);
  return point;
}

function discoverArchives(gamedataDir) {
  const found = [];
  for (const dir of [gamedataDir, path.join(gamedataDir, 'Data')]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (/\.mpq$/i.test(entry) && fs.statSync(path.join(dir, entry)).isFile()) {
        found.push({ dir, name: entry });
      }
    }
  }
  // patches override base archives; higher patch letters/numbers win
  // (client load order: base < patch < patch-2..9 < patch-A..Z)
  const prio = (n) => {
    const m = n.toLowerCase().match(/^patch(?:-([0-9a-z]))?\.mpq$/);
    if (!m) return 0;
    if (!m[1]) return 1000;
    const c = m[1].charCodeAt(0);
    return c >= 97 ? 2000 + c : 1000 + c; // letters above numbers
  };
  found.sort((a, b) => prio(b.name) - prio(a.name) || a.name.localeCompare(b.name));
  return found;
}

async function init(gamedataDir) {
  for (const a of archives) {
    try { a.mpq.close(); } catch (e) { /* already closed */ }
  }
  archives = [];
  errors = [];
  const found = discoverArchives(gamedataDir);
  if (!found.length) return list();
  const { MPQ } = loadStorm();
  for (const f of found) {
    try {
      const point = mountDir(f.dir);
      const mpq = await MPQ.open(`${point}/${f.name}`, 'r');
      archives.push({ name: f.name, mpq });
    } catch (e) {
      errors.push({ name: f.name, error: e.message || String(e) });
    }
  }
  return list();
}

function list() {
  return { archives: archives.map((a) => a.name), errors };
}

// Read a virtual path (e.g. "Spells\\Fireball.m2") from the archive chain.
function readFile(vpath) {
  const name = String(vpath).replace(/\//g, '\\');
  for (const a of archives) {
    try {
      if (!a.mpq.hasFile(name)) continue;
      const f = a.mpq.openFile(name);
      const buf = Buffer.from(f.read());
      f.close();
      return { archive: a.name, data: buf };
    } catch (e) {
      // corrupt entry in one archive shouldn't kill the chain
    }
  }
  return null;
}

module.exports = { init, list, readFile };
