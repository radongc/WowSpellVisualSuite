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

  // Deep-clone a SpellVisual: the visual record itself, every kit it references,
  // and (optionally) every effect those kits/the visual reference. All internal
  // references are rewired to the new IDs. Returns an old->new ID map per table.
  cloneVisualChain(visualId, { cloneEffects = true, spellId = null, spellSlot = 0 } = {}) {
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
      rec.Name = (src.Name || 'effect') + ' (copy)';
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
      const spell = spells.byId.get(spellId);
      spell.SpellVisualID[spellSlot === 1 ? 1 : 0] = newVisual.ID;
      spells.dirty = true;
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
