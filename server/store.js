// Loads all DBC tables into memory, tracks edits, saves back with backups.
const fs = require('fs');
const path = require('path');
const dbc = require('./dbc');
const { SCHEMAS } = require('./schemas');

const DBC_DIR = path.join(__dirname, '..', 'dbc');
const BACKUP_DIR = path.join(DBC_DIR, 'backup');

class Store {
  constructor() {
    this.tables = {};   // name -> { records, byId: Map, dirty: bool }
    this.status = {};   // name -> { state: 'ok'|'missing'|'error', error?, recordCount? }
  }

  load() {
    for (const name of Object.keys(SCHEMAS)) {
      const file = path.join(DBC_DIR, name + '.dbc');
      if (!fs.existsSync(file)) {
        this.status[name] = { state: 'missing' };
        continue;
      }
      try {
        const buf = fs.readFileSync(file);
        const { records } = dbc.parse(buf, SCHEMAS[name], name);
        const byId = new Map(records.map((r) => [r.ID, r]));
        this.tables[name] = { records, byId, dirty: false };
        this.status[name] = { state: 'ok', recordCount: records.length };
      } catch (e) {
        this.status[name] = { state: 'error', error: e.message };
      }
    }
  }

  get(name) {
    return this.tables[name] || null;
  }

  getRecord(name, id) {
    const t = this.tables[name];
    return t ? t.byId.get(id) || null : null;
  }

  updateRecord(name, id, data) {
    const t = this.tables[name];
    if (!t) throw new Error(`table ${name} not loaded`);
    const rec = t.byId.get(id);
    if (!rec) throw new Error(`${name} #${id} not found`);
    const schema = SCHEMAS[name];
    for (const fld of schema) {
      if (fld.name === 'ID' || !(fld.name in data)) continue;
      rec[fld.name] = data[fld.name];
    }
    t.dirty = true;
    return rec;
  }

  createRecord(name, { id, cloneFrom } = {}) {
    const t = this.tables[name];
    if (!t) throw new Error(`table ${name} not loaded`);
    const schema = SCHEMAS[name];
    let newId = id;
    if (newId == null) {
      newId = t.records.reduce((m, r) => Math.max(m, r.ID), 0) + 1;
    }
    if (t.byId.has(newId)) throw new Error(`${name} #${newId} already exists`);
    let rec;
    const src = cloneFrom != null ? t.byId.get(cloneFrom) : null;
    if (cloneFrom != null && !src) throw new Error(`${name} #${cloneFrom} not found to clone`);
    if (src) {
      rec = JSON.parse(JSON.stringify(src));
    } else {
      rec = {};
      for (const fld of schema) {
        const blank = () =>
          fld.type === 'string' ? '' :
          fld.type === 'loc' ? Object.fromEntries([...dbc.LOC_LANGS.map((l) => [l, '']), ['flags', 0]]) : 0;
        rec[fld.name] = fld.arraySize ? Array.from({ length: fld.arraySize }, blank) : blank();
      }
    }
    rec.ID = newId;
    t.records.push(rec);
    t.byId.set(newId, rec);
    t.dirty = true;
    return rec;
  }

  deleteRecord(name, id) {
    const t = this.tables[name];
    if (!t) throw new Error(`table ${name} not loaded`);
    if (!t.byId.has(id)) throw new Error(`${name} #${id} not found`);
    t.byId.delete(id);
    t.records = t.records.filter((r) => r.ID !== id);
    t.dirty = true;
  }

  dirtyTables() {
    return Object.keys(this.tables).filter((n) => this.tables[n].dirty);
  }

  // Writes dirty tables to disk; originals are copied to dbc/backup/<timestamp>/ first.
  save() {
    const dirty = this.dirtyTables();
    if (dirty.length === 0) return { saved: [], backupDir: null };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(BACKUP_DIR, stamp);
    fs.mkdirSync(backupDir, { recursive: true });
    for (const name of dirty) {
      const file = path.join(DBC_DIR, name + '.dbc');
      if (fs.existsSync(file)) {
        fs.copyFileSync(file, path.join(backupDir, name + '.dbc'));
      }
    }
    const saved = [];
    for (const name of dirty) {
      const t = this.tables[name];
      const sorted = [...t.records].sort((a, b) => a.ID - b.ID);
      const buf = dbc.write(sorted, SCHEMAS[name], name);
      fs.writeFileSync(path.join(DBC_DIR, name + '.dbc'), buf);
      t.records = sorted;
      t.dirty = false;
      saved.push(name);
      this.status[name] = { state: 'ok', recordCount: sorted.length };
    }
    return { saved, backupDir };
  }
}

module.exports = { Store, DBC_DIR };
