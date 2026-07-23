// Loads all DBC tables into memory, tracks edits, saves back with backups.
const fs = require('fs');
const path = require('path');
const dbc = require('./dbc');
const { SCHEMAS } = require('./schemas');

const DBC_DIR = path.join(__dirname, '..', 'dbc');
const BACKUP_DIR = path.join(DBC_DIR, 'backup');

const HISTORY_CAP = 200;
const copy = (v) => JSON.parse(JSON.stringify(v));

class Store {
  constructor() {
    this.tables = {};   // name -> { records, byId: Map, dirty: bool, dirtyIds?: Set, deletedIds?: Set }
    this.status = {};   // name -> { state: 'ok'|'missing'|'error', error?, recordCount? }
    this.undoStack = []; // [{ label, ops: [{type, table, id, before?, after?, record?}] }]
    this.redoStack = [];
    this._txn = null;
    this.mysqlTables = new Set(); // tables sourced from (and saved back to) MySQL
  }

  // Track which rows changed so a MySQL save can upsert/delete just those,
  // instead of rewriting an entire 22k-row table. Harmless in file mode.
  _markRow(name, id, deleted) {
    const t = this.tables[name];
    if (!t) return;
    t.dirtyIds = t.dirtyIds || new Set();
    t.deletedIds = t.deletedIds || new Set();
    if (deleted) { t.deletedIds.add(id); t.dirtyIds.delete(id); }
    else { t.dirtyIds.add(id); t.deletedIds.delete(id); }
  }

  // --- undo/redo history (record edits only; file ops clear it) ---

  clearHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._txn = null;
  }

  _pushOp(op, label) {
    if (this._txn) { this._txn.ops.push(op); return; }
    this.undoStack.push({ label, ops: [op] });
    if (this.undoStack.length > HISTORY_CAP) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  beginTxn(label) { this._txn = { label, ops: [] }; }

  commitTxn() {
    if (this._txn && this._txn.ops.length) {
      this.undoStack.push(this._txn);
      if (this.undoStack.length > HISTORY_CAP) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    this._txn = null;
  }

  _setRecord(name, id, data) {
    const t = this.tables[name];
    if (!t) return;
    if (data == null) {
      t.byId.delete(id);
      t.records = t.records.filter((r) => r.ID !== id);
    } else {
      const rec = copy(data);
      const i = t.records.findIndex((r) => r.ID === id);
      if (i >= 0) t.records[i] = rec;
      else t.records.push(rec);
      t.byId.set(id, rec);
    }
    t.dirty = true;
    this._markRow(name, id, data == null);
    if (this.status[name]) this.status[name].recordCount = t.records.length;
  }

  _applyOp(op, dir) {
    if (op.type === 'update') this._setRecord(op.table, op.id, dir === 'undo' ? op.before : op.after);
    else if (op.type === 'create') this._setRecord(op.table, op.id, dir === 'undo' ? null : op.record);
    else if (op.type === 'delete') this._setRecord(op.table, op.id, dir === 'undo' ? op.record : null);
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    for (let i = entry.ops.length - 1; i >= 0; i--) this._applyOp(entry.ops[i], 'undo');
    this.redoStack.push(entry);
    return entry;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    for (const op of entry.ops) this._applyOp(op, 'redo');
    this.undoStack.push(entry);
    return entry;
  }

  historyInfo() {
    return {
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
      nextUndo: this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : null,
      nextRedo: this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : null,
    };
  }

  load() {
    this.clearHistory();
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
    const before = copy(rec);
    const schema = SCHEMAS[name];
    for (const fld of schema) {
      if (fld.name === 'ID' || !(fld.name in data)) continue;
      rec[fld.name] = data[fld.name];
    }
    if (JSON.stringify(before) !== JSON.stringify(rec)) {
      this._pushOp({ type: 'update', table: name, id, before, after: copy(rec) }, `edit ${name} #${id}`);
      this._markRow(name, id, false);
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
    this._markRow(name, newId, false);
    this._pushOp({ type: 'create', table: name, id: newId, record: copy(rec) },
      cloneFrom != null ? `clone ${name} #${cloneFrom} → #${newId}` : `create ${name} #${newId}`);
    return rec;
  }

  // Deep-clone a SpellVisual: the visual record itself, every kit it references,
  // and (optionally) every effect those kits/the visual reference. All internal
  // references are rewired to the new IDs. Returns an old->new ID map per table.
  cloneVisualChain(visualId, opts = {}) {
    this.beginTxn(`clone visual chain #${visualId}`);
    try {
      const result = this._cloneVisualChain(visualId, opts);
      this.commitTxn();
      return result;
    } catch (e) {
      this._txn = null;
      throw e;
    }
  }

  _cloneVisualChain(visualId, { cloneEffects = true, spellId = null, spellSlot = 0 } = {}) {
    const visuals = this.tables.SpellVisual;
    const kits = this.tables.SpellVisualKit;
    if (!visuals || !kits) throw new Error('SpellVisual / SpellVisualKit not loaded');
    if (!visuals.byId.has(visualId)) throw new Error(`SpellVisual #${visualId} not found`);

    const KIT_FIELDS = ['PrecastKit', 'CastKit', 'ImpactKit', 'StateKit', 'ChannelKit', 'AreaKit'];
    const KIT_EFFECT_FIELDS = ['HeadEffect', 'ChestEffect', 'BaseEffect', 'LeftHandEffect', 'RightHandEffect', 'BreathEffect', 'WorldEffect'];
    const VISUAL_EFFECT_FIELDS = ['MissileModel', 'AreaModel'];

    const effectMap = new Map();
    const cloneEffect = (oldId) => {
      if (oldId == null || oldId <= 0) return oldId;
      if (effectMap.has(oldId)) return effectMap.get(oldId);
      const src = this.tables.SpellVisualEffectName && this.tables.SpellVisualEffectName.byId.get(oldId);
      if (!src) return oldId; // dangling ref — keep as-is
      const rec = this.createRecord('SpellVisualEffectName', { cloneFrom: oldId });
      this.updateRecord('SpellVisualEffectName', rec.ID, { Name: (src.Name || 'effect') + ' (copy)' });
      effectMap.set(oldId, rec.ID);
      return rec.ID;
    };

    const kitMap = new Map();
    const cloneKit = (oldId) => {
      if (oldId == null || oldId <= 0) return oldId;
      if (kitMap.has(oldId)) return kitMap.get(oldId);
      if (!kits.byId.has(oldId)) return oldId; // dangling ref — keep as-is
      const rec = this.createRecord('SpellVisualKit', { cloneFrom: oldId });
      kitMap.set(oldId, rec.ID);
      if (cloneEffects) {
        for (const f of KIT_EFFECT_FIELDS) rec[f] = rec[f] > 0 ? cloneEffect(rec[f]) : rec[f];
        rec.SpecialEffect = rec.SpecialEffect.map((e) => (e > 0 ? cloneEffect(e) : e));
      }
      return rec.ID;
    };

    const newVisual = this.createRecord('SpellVisual', { cloneFrom: visualId });
    for (const f of KIT_FIELDS) newVisual[f] = newVisual[f] > 0 ? cloneKit(newVisual[f]) : newVisual[f];
    if (cloneEffects) {
      for (const f of VISUAL_EFFECT_FIELDS) newVisual[f] = newVisual[f] > 0 ? cloneEffect(newVisual[f]) : newVisual[f];
    }

    if (spellId != null) {
      const spells = this.tables.Spell;
      if (!spells || !spells.byId.has(spellId)) throw new Error(`Spell #${spellId} not found`);
      const vis = spells.byId.get(spellId).SpellVisualID.slice();
      vis[spellSlot === 1 ? 1 : 0] = newVisual.ID;
      this.updateRecord('Spell', spellId, { SpellVisualID: vis });
    }

    return {
      visual: { [visualId]: newVisual.ID },
      kits: Object.fromEntries(kitMap),
      effects: Object.fromEntries(effectMap),
    };
  }

  deleteRecord(name, id) {
    const t = this.tables[name];
    if (!t) throw new Error(`table ${name} not loaded`);
    if (!t.byId.has(id)) throw new Error(`${name} #${id} not found`);
    this._pushOp({ type: 'delete', table: name, id, record: copy(t.byId.get(id)) }, `delete ${name} #${id}`);
    t.byId.delete(id);
    t.records = t.records.filter((r) => r.ID !== id);
    t.dirty = true;
    this._markRow(name, id, true);
  }

  dirtyTables() {
    return Object.keys(this.tables).filter((n) => this.tables[n].dirty);
  }

  // ---- MySQL backend (opt-in; pairs with Stoneharry's shared database) ----

  // Replace the given tables' in-memory data with the MySQL copy. A table that
  // MySQL lacks, or whose layout doesn't line up, is left untouched (keeps the
  // file/archive copy). Populates mysqlTables so saves route back to MySQL.
  async loadFromMysql(mysqldb, names) {
    for (const name of names) {
      if (!SCHEMAS[name]) continue;
      let records;
      try { records = await mysqldb.readTable(name, SCHEMAS[name]); }
      catch (e) { console.log(`  !! MySQL read ${name}: ${e.message}`); continue; }
      if (records == null) continue; // absent or layout mismatch — keep existing source
      const byId = new Map(records.map((r) => [r.ID, r]));
      this.tables[name] = { records, byId, dirty: false, dirtyIds: new Set(), deletedIds: new Set() };
      this.status[name] = { state: 'ok', recordCount: records.length, source: 'mysql' };
      this.mysqlTables.add(name);
    }
    this.clearHistory();
    return [...this.mysqlTables];
  }

  // Push changed/new rows (and deletions) of every dirty MySQL-backed table back
  // to the shared database. Only touched rows move, so this stays cheap even for
  // Spell. Returns the list of tables written.
  async saveToMysql(mysqldb) {
    const saved = [];
    for (const name of this.mysqlTables) {
      const t = this.tables[name];
      if (!t || !t.dirty) continue;
      const upserts = [...(t.dirtyIds || [])].map((id) => t.byId.get(id)).filter(Boolean);
      const deletes = [...(t.deletedIds || [])];
      await mysqldb.upsertRows(name, SCHEMAS[name], upserts);
      if (deletes.length) await mysqldb.deleteRows(name, SCHEMAS[name], deletes);
      t.dirty = false;
      t.dirtyIds = new Set();
      t.deletedIds = new Set();
      saved.push({ table: name, upserted: upserts.length, deleted: deletes.length });
    }
    return { saved };
  }

  // Load a table from an in-memory buffer (e.g. a DBC read straight out of the
  // client's MPQ archives). Used to auto-fill tables missing from dbc/.
  loadFromBuffer(name, buf, source) {
    this.clearHistory();
    const { records } = dbc.parse(buf, SCHEMAS[name], name);
    const byId = new Map(records.map((r) => [r.ID, r]));
    this.tables[name] = { records, byId, dirty: false };
    this.status[name] = { state: 'ok', recordCount: records.length, source };
  }

  // Drop in-memory edits to one table by re-reading it from dbc/. Returns false
  // if there is no disk file (caller may fall back to the MPQ chain).
  reloadTable(name) {
    this.clearHistory();
    if (!SCHEMAS[name]) throw new Error(`unknown table ${name}`);
    const file = path.join(DBC_DIR, name + '.dbc');
    if (!fs.existsSync(file)) return false;
    const { records } = dbc.parse(fs.readFileSync(file), SCHEMAS[name], name);
    const byId = new Map(records.map((r) => [r.ID, r]));
    this.tables[name] = { records, byId, dirty: false };
    this.status[name] = { state: 'ok', recordCount: records.length };
    return true;
  }

  // Serialize the current in-memory state of a table to WDBC bytes without
  // touching the files on disk (used by the export dialog).
  serializeTable(name) {
    const t = this.tables[name];
    if (!t) throw new Error(`table ${name} not loaded`);
    const sorted = [...t.records].sort((a, b) => a.ID - b.ID);
    return dbc.write(sorted, SCHEMAS[name], name);
  }

  // Validate and install an uploaded .dbc: parse against the schema first, back
  // up the existing file, write, and reload the table into memory.
  importTable(name, buf) {
    this.clearHistory();
    if (!SCHEMAS[name]) throw new Error(`unknown table ${name}`);
    const { records } = dbc.parse(buf, SCHEMAS[name], name); // throws if invalid
    const file = path.join(DBC_DIR, name + '.dbc');
    if (fs.existsSync(file)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.join(BACKUP_DIR, stamp);
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(file, path.join(backupDir, name + '.dbc'));
    }
    fs.writeFileSync(file, buf);
    const byId = new Map(records.map((r) => [r.ID, r]));
    this.tables[name] = { records, byId, dirty: false };
    this.status[name] = { state: 'ok', recordCount: records.length };
    return { recordCount: records.length };
  }

  // Writes dirty tables to disk; originals are copied to dbc/backup/<timestamp>/ first.
  // MySQL-backed tables are skipped here — they persist via saveToMysql instead.
  save() {
    const dirty = this.dirtyTables().filter((n) => !this.mysqlTables.has(n));
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
