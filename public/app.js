/* Spell Visual Editor — frontend logic. No dependencies. */
'use strict';

// ---------- constants / reference data ----------

// Common vanilla AnimationData names (partial — raw ID always shown too).
const ANIM_NAMES = {
  0: 'Stand', 1: 'Death', 2: 'Spell', 3: 'Stop', 4: 'Walk', 5: 'Run', 6: 'Dead', 7: 'Rise',
  8: 'StandWound', 9: 'CombatWound', 10: 'CombatCritical', 13: 'Walkbackwards', 14: 'Stun',
  15: 'HandsClosed', 16: 'AttackUnarmed', 17: 'Attack1H', 18: 'Attack2H', 19: 'Attack2HL',
  24: 'ShieldBlock', 25: 'ReadyUnarmed', 26: 'Ready1H', 27: 'Ready2H', 28: 'Ready2HL',
  29: 'ReadyBow', 30: 'Dodge', 31: 'SpellPrecast', 32: 'SpellCast', 33: 'SpellCastArea',
  34: 'NPCWelcome', 35: 'NPCGoodbye', 36: 'Block', 37: 'JumpStart', 38: 'Jump', 39: 'JumpEnd',
  40: 'Fall', 41: 'SwimIdle', 42: 'Swim', 46: 'AttackBow', 47: 'FireBow', 48: 'ReadyRifle',
  49: 'AttackRifle', 50: 'Loot', 60: 'Kick', 63: 'Talk', 64: 'Fidget', 66: 'Chop',
  69: 'ReadyThrown', 70: 'AttackThrown', 78: 'SpellCastDirected', 82: 'Land', 91: 'EmoteEat',
  94: 'EmoteWork', 97: 'EmoteWorkMining', 98: 'EmoteWorkChopping', 108: 'EmoteTalkQuestion',
  109: 'EmoteBow', 115: 'EmotePoint', 120: 'EmoteSalute', 123: 'EmoteRoar', 133: 'EmoteBeg',
  135: 'EmoteDance', 138: 'EmoteShout', 143: 'EmoteEatNoSheathe',
};

const PATH_TYPES = { 0: 'Straight', 1: 'Arc (low)', 2: 'Arc (high)' };

// Attachment points (client attachment IDs).
const ATTACH_POINTS = {
  '-1': 'None', 0: 'Shield / Mount', 1: 'Hand Right', 2: 'Hand Left', 3: 'Elbow Right',
  4: 'Elbow Left', 5: 'Shoulder Right', 6: 'Shoulder Left', 7: 'Knee Right', 8: 'Knee Left',
  9: 'Hip Right', 10: 'Hip Left', 11: 'Helm', 12: 'Back', 13: 'Shoulder Flap Right',
  14: 'Shoulder Flap Left', 15: 'Chest Blood Front', 16: 'Chest Blood Back', 17: 'Breath',
  18: 'Player Name', 19: 'Base', 20: 'Head', 21: 'Spell Left Hand', 22: 'Spell Right Hand',
  23: 'Special 1', 24: 'Special 2', 25: 'Special 3', 26: 'Sheath Main Hand',
  27: 'Sheath Off Hand', 28: 'Sheath Shield', 29: 'Player Name Mounted',
  30: 'Large Weapon Left', 31: 'Large Weapon Right', 32: 'Hip Weapon Left',
  33: 'Hip Weapon Right', 34: 'Chest', 35: 'Hand Arrow', 36: 'Bullet',
  37: 'Spell Hand Omni', 38: 'Spell Hand Directed',
};

// Vanilla playable-race character models for the attachment lab mannequin.
const CHAR_MODELS = ['Human', 'Orc', 'Dwarf', 'NightElf', 'Scourge', 'Tauren', 'Gnome', 'Troll']
  .flatMap((r) => ['Male', 'Female'].map((g) => `Character\\${r}\\${g}\\${r}${g}.m2`));

const KIT_SLOT_FIELDS = [
  ['HeadEffect', 'Head'], ['ChestEffect', 'Chest'], ['BaseEffect', 'Base'],
  ['LeftHandEffect', 'Left hand'], ['RightHandEffect', 'Right hand'], ['BreathEffect', 'Breath'],
];

const VISUAL_KIT_SLOTS = [
  ['PrecastKit', 'Precast', 'Plays while casting (before release)'],
  ['CastKit', 'Cast', 'Plays on the caster at release'],
  ['ImpactKit', 'Impact', 'Plays on the target on hit'],
  ['StateKit', 'State', 'Looping aura state on the target'],
  ['ChannelKit', 'Channel', 'Plays while channeling'],
  ['AreaKit', 'Area', 'Plays for the area effect'],
];

// ---------- tiny DOM helpers ----------

const $ = (sel) => document.querySelector(sel);
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === false) { /* boolean attribute off — omit entirely */ }
    else if (v === true) e.setAttribute(k, '');
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    e.append(c.nodeType ? c : document.createTextNode(c));
  }
  return e;
}

let toastTimer = null;
function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 2500);
}

// ---------- api ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

// ---------- state ----------

const state = {
  status: null,
  tab: 'spells',
  search: '',
  selection: null,          // { type, id }
  crumbs: [],               // [{type, id, label}]
  spellPage: { records: [], total: 0, offset: 0 },
  tables: {},               // name -> records array
  byId: {},                 // name -> Map
  saveTimers: new Map(),    // "table:id" -> timeout
};

const TAB_DEF = {
  spells:  { table: 'Spell', type: 'spell', label: 'spell' },
  visuals: { table: 'SpellVisual', type: 'visual', label: 'visual' },
  kits:    { table: 'SpellVisualKit', type: 'kit', label: 'kit' },
  effects: { table: 'SpellVisualEffectName', type: 'effect', label: 'effect' },
};

function tbl(name) { return state.tables[name] || []; }
function rec(name, id) { return state.byId[name] ? state.byId[name].get(id) : null; }
function effectLabel(id) {
  if (id == null || id <= 0) return null;
  const e = rec('SpellVisualEffectName', id);
  return e ? `${e.Name || '(unnamed)'}` : `#${id} (missing!)`;
}

async function loadTable(name) {
  try {
    const data = await api(`/api/table/${name}`);
    state.tables[name] = data.records;
    state.byId[name] = new Map(data.records.map((r) => [r.ID, r]));
  } catch (e) {
    state.tables[name] = [];
    state.byId[name] = new Map();
  }
}

// ---------- edit / persist ----------

function markDirtySoon() { refreshStatus(); }

async function doSave(table, record) {
  try {
    await api(`/api/table/${table}/${record.ID}`, { method: 'PUT', body: record });
    markDirtySoon();
  } catch (e) {
    toast(`Failed to apply ${table} #${record.ID}: ${e.message}`, true);
  }
}

function scheduleSave(table, record) {
  const key = `${table}:${record.ID}`;
  clearTimeout(state.saveTimers.get(key));
  state.saveTimers.set(key, setTimeout(() => {
    state.saveTimers.delete(key);
    doSave(table, record);
  }, 250));
}

// Flush any pending debounced save for this record immediately and await the
// PUT — use before re-fetching/re-rendering so a fresh GET can't race ahead of
// the write and read back the stale value.
async function saveNow(table, record) {
  const key = `${table}:${record.ID}`;
  clearTimeout(state.saveTimers.get(key));
  state.saveTimers.delete(key);
  await doSave(table, record);
}

async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const dirty = state.status.dirty || [];
    $('#dirty-indicator').hidden = dirty.length === 0;
    $('#dirty-tables').textContent = dirty.join(', ');
    const h = state.status.history || {};
    const bu = $('#btn-undo'), br = $('#btn-redo');
    bu.disabled = !h.undoCount;
    br.disabled = !h.redoCount;
    bu.title = h.nextUndo ? `Undo: ${h.nextUndo} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    br.title = h.nextRedo ? `Redo: ${h.nextRedo} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
  } catch (e) { /* server down; leave as-is */ }
}

async function doUndoRedo(kind) {
  try {
    const r = await api(`/api/${kind}`, { method: 'POST' });
    for (const t of r.tables) {
      if (state.tables[t]) await loadTable(t);
    }
    buildDatalists();
    await refreshStatus();
    renderList();
    renderEditor();
    toast(`${kind === 'undo' ? 'Undid' : 'Redid'}: ${r.label}`);
  } catch (e) {
    if (e.status === 404) toast(`Nothing to ${kind}.`);
    else toast(`${kind} failed: ${e.message}`, true);
  }
}

// ---------- sidebar list ----------

async function renderList(append = false) {
  const list = $('#list');
  const more = $('#list-more');
  if (!append) list.textContent = '';
  const q = state.search.trim();

  if (state.tab === 'spells') {
    const spellStatus = state.status && state.status.tables.Spell;
    if (!spellStatus || spellStatus.state !== 'ok') {
      more.hidden = true;
      list.append(el('div', { class: 'banner', style: 'margin:10px' },
        el('b', {}, 'Spell.dbc could not be loaded. '),
        el('div', {}, spellStatus && spellStatus.error ? spellStatus.error : 'File missing.'),
        el('div', { style: 'margin-top:6px' },
          'Replace dbc/Spell.dbc with a valid 1.12.1 export, restart the server (or hit Reload), and the spell browser will light up. You can still edit Visuals, Kits and Effects directly.')));
      return;
    }
    const offset = append ? state.spellPage.offset + 100 : 0;
    const page = await api(`/api/spells?q=${encodeURIComponent(q)}&offset=${offset}&limit=100`);
    state.spellPage = { ...page, offset };
    for (const s of page.records) {
      const item = listItem('spell', s.ID, s.name || '(unnamed)', s.rank || '');
      if (s.icon > 0) {
        const img = el('img', { class: 'spell-icon', src: `/api/icon/${s.icon}`, loading: 'lazy' });
        img.onerror = () => img.remove();
        item.prepend(img);
      }
      list.append(item);
    }
    more.hidden = offset + 100 >= page.total;
    return;
  }

  // Visuals / kits / effects live entirely in memory (a couple of thousand rows
  // at most), so render every match rather than capping the list — batched into
  // a fragment so one reflow covers the whole thing.
  more.hidden = true;
  const def = TAB_DEF[state.tab];
  const ql = q.toLowerCase();
  const isNum = /^\d+$/.test(q);
  const frag = document.createDocumentFragment();
  let count = 0;
  for (const r of tbl(def.table)) {
    let name = '', sub = '';
    if (def.type === 'visual') {
      const kits = VISUAL_KIT_SLOTS.filter(([f]) => r[f] > 0).map(([, l]) => l);
      name = kits.length ? kits.join(', ') : '(empty visual)';
      sub = r.HasMissile ? 'missile' : '';
    } else if (def.type === 'kit') {
      const fx = [...KIT_SLOT_FIELDS.map(([f]) => r[f]), ...r.SpecialEffect, r.WorldEffect].filter((v) => v > 0);
      const first = fx.length ? effectLabel(fx[0]) : null;
      name = first ? `${first}${fx.length > 1 ? ` +${fx.length - 1}` : ''}` : '(no effects)';
      sub = r.AnimID > 0 ? (ANIM_NAMES[r.AnimID] || `anim ${r.AnimID}`) : '';
    } else if (def.type === 'effect') {
      name = r.Name || '(unnamed)';
      sub = (r.FileName || '').split('\\').pop();
    }
    if (q && !(isNum && r.ID === Number(q)) && !name.toLowerCase().includes(ql) && !sub.toLowerCase().includes(ql)) continue;
    frag.append(listItem(def.type, r.ID, name, sub));
    count++;
  }
  list.append(frag);
  list.append(el('div', { class: 'list-item list-count' },
    el('span', { class: 'sub' }, count
      ? `${count} ${def.label}${count === 1 ? '' : 's'}${q ? ` matching “${q}”` : ''}`
      : `no ${def.label}s match “${q}”`)));
}

function listItem(type, id, name, sub) {
  const sel = state.selection;
  const item = el('div', {
    class: 'list-item' + (sel && sel.type === type && sel.id === id ? ' selected' : ''),
    onclick: () => select(type, id),
  },
    el('span', { class: 'id' }, id),
    el('span', { class: 'nm' }, name),
    sub ? el('span', { class: 'sub' }, sub) : null);
  item.dataset.type = type;
  item.dataset.id = id;
  return item;
}

function select(type, id, crumbs) {
  state.selection = { type, id };
  state.crumbs = crumbs || [];
  if (location.hash !== `#${type}/${id}`) history.replaceState(null, '', `#${type}/${id}`);
  document.querySelectorAll('.list-item.selected').forEach((n) => n.classList.remove('selected'));
  const li = document.querySelector(`.list-item[data-type="${type}"][data-id="${id}"]`);
  if (li) li.classList.add('selected');
  $('#btn-clone').disabled = $('#btn-delete').disabled = (type === 'spell' && !state.byId.Spell);
  renderEditor();
}

// ---------- editors ----------

function renderEditor() {
  const sel = state.selection;
  stopStoryboard();
  if (lab && (!sel || sel.type !== 'effect' || sel.id !== lab.effect.ID)) {
    lab = null;
    Viewer.setLabDrag(null);
  }
  const empty = $('#editor-empty');
  const content = $('#editor-content');
  if (!sel) { empty.hidden = false; content.hidden = true; return; }
  empty.hidden = true;
  content.hidden = false;
  content.textContent = '';

  if (state.crumbs.length) {
    const c = el('div', { class: 'crumbs' });
    state.crumbs.forEach((cr, i) => {
      c.append(el('a', { onclick: () => select(cr.type, cr.id, state.crumbs.slice(0, i)) }, cr.label), ' › ');
    });
    c.append(el('span', {}, selLabel(sel)));
    content.append(c);
  }

  if (sel.type === 'spell') renderSpellEditor(content, sel.id);
  else if (sel.type === 'visual') renderVisualEditor(content, sel.id);
  else if (sel.type === 'kit') renderKitEditor(content, sel.id);
  else if (sel.type === 'effect') renderEffectEditor(content, sel.id);
}

function selLabel(sel) {
  return `${TAB_DEF[Object.keys(TAB_DEF).find((k) => TAB_DEF[k].type === sel.type)].label} #${sel.id}`;
}

function crumbFor(sel) {
  return { ...sel, label: selLabel(sel) };
}

// --- field widgets ---

function numField(record, table, field, label, opts = {}) {
  const isArray = Array.isArray(record[field]);
  const value = opts.index != null ? record[field][opts.index] : record[field];
  const input = el('input', {
    type: 'number', step: opts.float ? 'any' : '1', value,
    class: 'mono',
    onchange: (e) => {
      const v = opts.float ? parseFloat(e.target.value) || 0 : Math.trunc(Number(e.target.value)) || 0;
      if (opts.index != null) record[field][opts.index] = v;
      else record[field] = v;
      if (sub && opts.subtextFn) sub.textContent = opts.subtextFn(v);
      scheduleSave(table, record);
      if (opts.after) opts.after(v);
    },
  });
  const sub = (opts.subtextFn || opts.subtext)
    ? el('div', { class: 'subtext' }, opts.subtextFn ? opts.subtextFn(value) : opts.subtext) : null;
  return el('div', { class: 'fld' + (opts.wide ? ' wide' : '') },
    el('label', {}, label, opts.labelExtra ? ' ' : null, opts.labelExtra || null), input, sub);
}

function textField(record, table, field, label, opts = {}) {
  const input = el('input', {
    type: 'text', value: record[field] || '', class: opts.mono ? 'mono' : '',
    onchange: (e) => { record[field] = e.target.value; scheduleSave(table, record); if (opts.after) opts.after(); },
  });
  return el('div', { class: 'fld' + (opts.wide ? ' wide' : '') }, el('label', {}, label), input);
}

function boolField(record, table, field, label, opts = {}) {
  const input = el('input', {
    type: 'checkbox',
    onchange: (e) => { record[field] = e.target.checked ? 1 : 0; scheduleSave(table, record); if (opts.after) opts.after(); },
  });
  input.checked = !!record[field];
  return el('div', { class: 'fld' }, el('label', {}, label), el('div', { class: 'checkrow' }, input, el('span', { class: 'subtext' }, opts.subtext || '')));
}

function selectField(record, table, field, label, options, opts = {}) {
  const sel = el('select', {
    onchange: (e) => {
      record[field] = Number(e.target.value);
      scheduleSave(table, record);
      if (opts.after) opts.after();
    },
  });
  const current = record[field];
  let found = false;
  for (const [v, name] of options) {
    const o = el('option', { value: v }, name);
    if (Number(v) === current) { o.selected = true; found = true; }
    sel.append(o);
  }
  if (!found) sel.append(el('option', { value: current, selected: true }, `${current} (?)`));
  return el('div', { class: 'fld' }, el('label', {}, label), sel);
}

// Reference picker: numeric ID + datalist of labels + jump link + live label.
function refField(record, table, field, label, refDef, opts = {}) {
  const { datalistId, resolve, type } = refDef;
  const value = opts.index != null ? record[field][opts.index] : record[field];
  const labelSpan = el('div', { class: 'subtext' }, resolve(value) || (value > 0 ? `#${value} (missing!)` : 'none'));
  const input = el('input', {
    type: 'text', class: 'mono', list: datalistId, value,
    onchange: (e) => {
      // accept "123" or "123 — name" (datalist picks insert the whole label)
      const m = String(e.target.value).match(/-?\d+/);
      const v = m ? Number(m[0]) : 0;
      e.target.value = v;
      if (opts.index != null) record[field][opts.index] = v;
      else record[field] = v;
      labelSpan.textContent = resolve(v) || (v > 0 ? `#${v} (missing!)` : 'none');
      scheduleSave(table, record);
      if (opts.after) opts.after(v);
    },
  });
  const jump = el('button', {
    class: 'linkbtn', title: 'Open this record',
    onclick: () => {
      const v = opts.index != null ? record[field][opts.index] : record[field];
      if (v > 0) select(type, v, [...state.crumbs, crumbFor(state.selection)]);
    },
  }, 'open ↗');
  return el('div', { class: 'fld' + (opts.wide ? ' wide' : '') },
    el('label', {}, label, ' ', jump), input, labelSpan);
}

const REFS = {
  effect: {
    datalistId: 'dl-effects', type: 'effect',
    resolve: (id) => (id > 0 ? effectLabel(id) : null),
  },
  kit: {
    datalistId: 'dl-kits', type: 'kit',
    resolve: (id) => {
      if (id <= 0) return null;
      const k = rec('SpellVisualKit', id);
      if (!k) return `#${id} (missing!)`;
      const fx = [...KIT_SLOT_FIELDS.map(([f]) => k[f]), ...k.SpecialEffect, k.WorldEffect].filter((v) => v > 0);
      return fx.length ? fx.map((f) => effectLabel(f)).slice(0, 2).join(', ') + (fx.length > 2 ? ` +${fx.length - 2}` : '') : '(no effects)';
    },
  },
  visual: {
    datalistId: 'dl-visuals', type: 'visual',
    resolve: (id) => {
      if (id <= 0) return null;
      const v = rec('SpellVisual', id);
      if (!v) return `#${id} (missing!)`;
      const kits = VISUAL_KIT_SLOTS.filter(([f]) => v[f] > 0).map(([, l]) => l);
      return kits.join(', ') || '(empty visual)';
    },
  },
};

function buildDatalists() {
  for (const id of ['dl-effects', 'dl-kits', 'dl-visuals']) {
    const old = document.getElementById(id);
    if (old) old.remove();
  }
  const dlE = el('datalist', { id: 'dl-effects' });
  for (const e of tbl('SpellVisualEffectName')) dlE.append(el('option', { value: e.ID }, `${e.ID} — ${e.Name}`));
  const dlK = el('datalist', { id: 'dl-kits' });
  for (const k of tbl('SpellVisualKit')) dlK.append(el('option', { value: k.ID }, `${k.ID} — ${REFS.kit.resolve(k.ID)}`));
  const dlV = el('datalist', { id: 'dl-visuals' });
  for (const v of tbl('SpellVisual')) dlV.append(el('option', { value: v.ID }, `${v.ID} — ${REFS.visual.resolve(v.ID)}`));
  document.body.append(dlE, dlK, dlV);
}

// --- spell editor ---

async function renderSpellEditor(content, id) {
  let spell;
  try {
    spell = await api(`/api/table/Spell/${id}`);
  } catch (e) {
    content.append(el('div', { class: 'banner' }, `Could not load spell #${id}: ${e.message}`));
    return;
  }
  const headIcon = spell.SpellIconID > 0
    ? el('img', { class: 'spell-icon-lg', src: `/api/icon/${spell.SpellIconID}` }) : null;
  if (headIcon) headIcon.onerror = () => headIcon.remove();
  content.append(
    el('div', { class: 'ed-head' },
      headIcon,
      el('h2', {}, spell.Name.enUS || '(unnamed spell)'),
      el('span', { class: 'id-badge' }, `#${spell.ID}`),
      spell.NameSubtext.enUS ? el('span', { class: 'sub' }, spell.NameSubtext.enUS) : null),
    el('div', { class: 'ed-sub' }, spell.Description.enUS || ''));

  content.append(
    el('div', { class: 'card' },
      el('h3', {}, 'Spell visuals'),
      el('div', { class: 'field-grid' },
        refField(spell, 'Spell', 'SpellVisualID', 'Visual 1', REFS.visual, { index: 0, after: async () => { await saveNow('Spell', spell); renderEditor(); } }),
        refField(spell, 'Spell', 'SpellVisualID', 'Visual 2', REFS.visual, { index: 1, after: async () => { await saveNow('Spell', spell); renderEditor(); } })),
      spell.SpellVisualID[0] > 0 ? el('div', { style: 'margin-top:8px; display:flex; gap:8px; flex-wrap:wrap' },
        el('button', {
          class: 'primary',
          title: 'Play the full spell sequence with this spell’s cast time and missile speed',
          onclick: () => openStoryboard(spell.SpellVisualID[0], spell),
        }, '▶ Preview Spell'),
        el('button', {
          title: 'Clone visual 1 with all its kits and effects, and point this spell at the new copy — ready to customize without touching the original',
          onclick: () => cloneChain(spell.SpellVisualID[0], spell.ID, 0),
        }, `Clone chain of visual #${spell.SpellVisualID[0]} → assign to this spell`)) :
      el('div', { style: 'margin-top:8px' },
        el('button', {
          title: 'Create an empty SpellVisual, assign it as Visual 1, and open it so you can add kits',
          onclick: async () => {
            try {
              const id = await createLinkedRecord('SpellVisual', null);
              spell.SpellVisualID[0] = id;
              scheduleSave('Spell', spell);
              toast(`Created visual #${id}, assigned to this spell.`);
              select('visual', id, [crumbFor(state.selection)]);
            } catch (e2) { toast('Create failed: ' + e2.message, true); }
          },
        }, '+ Create new visual → assign to this spell'))));

  // inline visual chain for visual 1
  const vid = spell.SpellVisualID[0];
  if (vid > 0 && rec('SpellVisual', vid)) {
    const wrap = el('div', {});
    content.append(el('div', { class: 'card' },
      el('h3', {}, `Visual chain — SpellVisual #${vid} `,
        el('button', { class: 'linkbtn', onclick: () => select('visual', vid, [crumbFor(state.selection)]) }, 'open ↗')),
      wrap));
    renderVisualBody(wrap, rec('SpellVisual', vid), true);
  }

  content.append(el('div', { class: 'card' },
    el('h3', {}, 'Basic properties ', el('span', { class: 'hint' }, '(non-visual fields, for reference)')),
    el('div', { class: 'field-grid' },
      textLocField(spell, 'Name', 'Name'),
      textLocField(spell, 'NameSubtext', 'Rank'),
      numField(spell, 'Spell', 'SpellIconID', 'Icon ID', {
        // wait out the debounced PUT so the server has the new value, then
        // refresh the header icon and the sidebar row
        after: () => setTimeout(() => {
          if (state.selection && state.selection.type === 'spell') {
            renderEditor();
            renderList();
          }
        }, 450),
      }),
      numField(spell, 'Spell', 'CastingTimeIndex', 'Cast time index'),
      numField(spell, 'Spell', 'DurationIndex', 'Duration index'),
      numField(spell, 'Spell', 'RangeIndex', 'Range index'),
      numField(spell, 'Spell', 'Speed', 'Missile speed', { float: true, subtext: 'yards/sec for the missile visual' }))));

  function textLocField(record, field, label) {
    const input = el('input', {
      type: 'text', value: record[field].enUS || '',
      onchange: (e) => { record[field].enUS = e.target.value; scheduleSave('Spell', record); },
    });
    return el('div', { class: 'fld' }, el('label', {}, label + ' (enUS)'), input);
  }
  previewForVisualId(vid);
}

// --- visual editor ---

function renderVisualEditor(content, id) {
  const v = rec('SpellVisual', id);
  if (!v) { content.append(el('div', { class: 'banner' }, `SpellVisual #${id} not found.`)); return; }
  content.append(el('div', { class: 'ed-head' },
    el('h2', {}, 'Spell Visual'),
    el('span', { class: 'id-badge' }, `#${v.ID}`),
    el('button', {
      title: 'Clone this visual together with all its kits and effects, rewiring every reference to the new copies',
      onclick: () => cloneChain(v.ID),
    }, 'Deep clone chain'),
    el('button', {
      class: 'primary',
      title: 'Play the full spell sequence on a caster/target pair: precast → cast → missile → impact → state',
      onclick: () => openStoryboard(v.ID, null),
    }, '▶ Preview Spell')));
  const usedBy = el('div', { class: 'ed-sub' }, 'Looking up spells using this visual…');
  content.append(usedBy);
  api(`/api/spells?visual=${id}&limit=500`).then((page) => {
    usedBy.textContent = '';
    if (!page.total) { usedBy.append('Not referenced by any spell.'); return; }
    usedBy.append(`Used by ${page.total} spell(s): `,
      ...page.records.slice(0, 10).flatMap((s, i) => [
        i ? ', ' : '',
        el('a', { class: 'linkbtn', onclick: () => select('spell', s.ID, [crumbFor({ type: 'visual', id })]) },
          `${s.name || '#' + s.ID}${s.rank ? ` (${s.rank})` : ''}`),
      ]),
      page.total > 10 ? ` … +${page.total - 10} more` : '');
  }).catch((e) => {
    usedBy.textContent = e.status === 503
      ? 'Spell.dbc not loaded — cannot show which spells use this visual.'
      : `Spell lookup failed: ${e.message}`;
  });
  renderVisualBody(content, v, false);
  previewForVisualId(id);
}

// Slot headers are "<label>  <link>"; swap only the link, keeping the label node.
function setSlotLink(nameRow, link) {
  while (nameRow.childNodes.length > 1) nameRow.lastChild.remove();
  nameRow.append(link);
}

// First effect id referenced by a kit's attachment slots, or 0.
function firstKitEffect(kitId) {
  const k = kitId > 0 ? rec('SpellVisualKit', kitId) : null;
  if (!k) return 0;
  return [...KIT_SLOT_FIELDS.map(([f]) => k[f]), ...k.SpecialEffect, k.WorldEffect].find((x) => x > 0) || 0;
}

function renderVisualBody(content, v, compact) {
  // kit slots
  const grid = el('div', { class: 'slot-grid' });
  for (const [field, label, hint] of VISUAL_KIT_SLOTS) {
    const slot = el('div', { class: 'slot' });
    const nameRow = el('div', { class: 'slot-name' }, el('span', {}, label));
    slot.append(nameRow);
    // The header link and the greyed-out styling depend on the current kit id,
    // so refresh them in place when it changes — re-rendering the whole editor
    // would tear down (and, inside the spell editor, re-fetch) the entire page.
    const refreshSlot = () => {
      const kid = v[field];
      slot.classList.toggle('empty-slot', !(kid > 0));
      setSlotLink(nameRow, kid > 0
        ? el('a', { onclick: () => select('kit', kid, [...state.crumbs, crumbFor(state.selection)]) }, `kit #${kid} ↗`)
        : el('a', {
          title: `Create a blank kit and assign it as this visual's ${label} kit`,
          onclick: async () => {
            try {
              const id = await createLinkedRecord('SpellVisualKit', NEW_KIT_DEFAULTS);
              v[field] = id;
              scheduleSave('SpellVisual', v);
              toast(`Created kit #${id}, assigned as ${label}.`);
              select('kit', id, [...state.crumbs, crumbFor(state.selection)]);
            } catch (e2) { toast('Create failed: ' + e2.message, true); }
          },
        }, '+ new kit'));
    };
    refreshSlot();
    slot.append(refField(v, 'SpellVisual', field, hint, REFS.kit, {
      // preview the newly linked kit's model; if it has none, fall back to
      // whatever the visual still points at rather than blanking the viewer
      after: (kid) => {
        refreshSlot();
        const fx = firstKitEffect(kid);
        if (fx) previewEffectId(fx); else previewForVisualId(v.ID);
      },
    }));
    grid.append(slot);
  }
  content.append(el('div', { class: 'card' }, el('h3', {}, 'Visual kits'), grid));

  // missile
  content.append(el('div', { class: 'card' },
    el('h3', {}, 'Missile'),
    el('div', { class: 'field-grid' },
      boolField(v, 'SpellVisual', 'HasMissile', 'Has missile', { after: () => previewForVisualId(v.ID) }),
      refField(v, 'SpellVisual', 'MissileModel', 'Missile model', REFS.effect, { after: (val) => previewEffectId(val) }),
      selectField(v, 'SpellVisual', 'MissilePathType', 'Path type', Object.entries(PATH_TYPES)),
      selectField(v, 'SpellVisual', 'MissileDestinationAttachment', 'Destination attachment', Object.entries(ATTACH_POINTS)),
      numField(v, 'SpellVisual', 'MissileSound', 'Missile sound', {
        subtextFn: (val) => soundLabel(val),
        labelExtra: soundPlayButton(v, 'MissileSound'),
      }),
      numField(v, 'SpellVisual', 'MissileAttachment', 'Missile attachment'))));

  // area + misc
  content.append(el('div', { class: 'card' },
    el('h3', {}, 'Area effect & misc'),
    el('div', { class: 'field-grid' },
      boolField(v, 'SpellVisual', 'HasAreaEffect', 'Has area effect'),
      refField(v, 'SpellVisual', 'AreaModel', 'Area model', REFS.effect, { after: (val) => previewEffectId(val) }),
      refField(v, 'SpellVisual', 'AreaKit', 'Area kit (duplicate slot)', REFS.kit),
      numField(v, 'SpellVisual', 'AnimEventSoundID', 'Anim event sound', {
        subtextFn: (val) => soundLabel(val),
        labelExtra: soundPlayButton(v, 'AnimEventSoundID'),
      }))));
}

// --- kit editor ---

function renderKitEditor(content, id) {
  const k = rec('SpellVisualKit', id);
  if (!k) { content.append(el('div', { class: 'banner' }, `SpellVisualKit #${id} not found.`)); return; }
  content.append(el('div', { class: 'ed-head' },
    el('h2', {}, 'Visual Kit'),
    el('span', { class: 'id-badge' }, `#${k.ID}`)));

  const usedIn = [];
  for (const v of tbl('SpellVisual')) {
    for (const [field, label] of VISUAL_KIT_SLOTS) {
      if (v[field] === id) usedIn.push({ v, label });
    }
  }
  if (usedIn.length) {
    content.append(el('div', { class: 'ed-sub' }, 'Used by: ',
      ...usedIn.slice(0, 8).flatMap(({ v, label }, i) => [
        i ? ', ' : '',
        el('a', { class: 'linkbtn', onclick: () => select('visual', v.ID, [crumbFor(state.selection)]) }, `visual #${v.ID} (${label})`),
      ]),
      usedIn.length > 8 ? ` … +${usedIn.length - 8} more` : ''));
  }

  content.append(el('div', { class: 'card' },
    el('h3', {}, 'Animation & sound'),
    el('div', { class: 'field-grid' },
      numField(k, 'SpellVisualKit', 'KitType', 'Kit type'),
      numField(k, 'SpellVisualKit', 'AnimID', 'Animation', { subtextFn: (v) => animLabel(v) }),
      numField(k, 'SpellVisualKit', 'SoundID', 'Sound', {
        subtextFn: (v) => soundLabel(v),
        labelExtra: soundPlayButton(k, 'SoundID'),
      }),
      shakeField(k))));

  // attachment effect slots
  const grid = el('div', { class: 'slot-grid' });
  const allSlots = [
    ...KIT_SLOT_FIELDS.map(([f, l]) => ({ field: f, label: l })),
    { field: 'SpecialEffect', label: 'Special 1', index: 0 },
    { field: 'SpecialEffect', label: 'Special 2', index: 1 },
    { field: 'SpecialEffect', label: 'Special 3', index: 2 },
    { field: 'WorldEffect', label: 'World' },
  ];
  for (const s of allSlots) {
    const slot = el('div', { class: 'slot' });
    const nameRow = el('div', { class: 'slot-name' }, el('span', {}, s.label));
    slot.append(nameRow);
    // preview/+ new link and the greyed-out styling follow the slot's current
    // effect id, so rebuild just those when the id changes
    const refreshSlot = () => {
      const val = s.index != null ? k[s.field][s.index] : k[s.field];
      slot.classList.toggle('empty-slot', !(val > 0));
      setSlotLink(nameRow, val > 0
        ? el('a', { onclick: () => previewEffectId(val) }, 'preview')
        : el('a', {
          title: 'Create a new effect in this slot and pick its model from the browser',
          onclick: async () => {
            try {
              const eid = await createLinkedRecord('SpellVisualEffectName', { Name: `New ${s.label} effect`, Scale: 1 });
              if (s.index != null) k[s.field][s.index] = eid;
              else k[s.field] = eid;
              scheduleSave('SpellVisualKit', k);
              toast(`Created effect #${eid} in the ${s.label} slot — pick a model.`);
              select('effect', eid, [...state.crumbs, crumbFor(state.selection)]);
              openModelBrowser((path) => {
                const e2 = rec('SpellVisualEffectName', eid);
                if (!e2) return;
                e2.FileName = path;
                scheduleSave('SpellVisualEffectName', e2);
                renderEditor();
              });
            } catch (e2) { toast('Create failed: ' + e2.message, true); }
          },
        }, '+ new'));
    };
    refreshSlot();
    slot.append(refField(k, 'SpellVisualKit', s.field, 'Effect (-1 = none)', REFS.effect, {
      index: s.index,
      after: (v2) => { refreshSlot(); if (v2 > 0) previewEffectId(v2); },
    }));
    grid.append(slot);
  }
  content.append(el('div', { class: 'card' },
    el('h3', {}, 'Attached effects ', el('span', { class: 'hint' }, '(models from SpellVisualEffectName)')),
    grid));

  // char procs
  const table = el('table', { class: 'proc-table' },
    el('tr', {},
      el('th', {}, 'Proc type (-1 = none)'),
      el('th', {}, 'Param 0', el('span', { class: 'subtext' }, ' (often a packed 0xRRGGBB color)')),
      el('th', {}, 'Param 1'), el('th', {}, 'Param 2'), el('th', {}, 'Param 3')));
  for (let i = 0; i < 4; i++) {
    const row = el('tr', {});
    row.append(el('td', {}, procInput(k, 'CharProc', i, false)));
    for (const pf of ['CharParamZero', 'CharParamOne', 'CharParamTwo', 'CharParamThree']) {
      row.append(el('td', {}, procInput(k, pf, i, true)));
    }
    table.append(row);
  }
  content.append(el('div', { class: 'card' },
    el('h3', {}, 'Character procedures ', el('span', { class: 'hint' }, '(tints, glows, scale effects applied to the model)')),
    table));

  const firstFx = allSlots.map((s) => (s.index != null ? k[s.field][s.index] : k[s.field])).find((v2) => v2 > 0);
  previewEffectId(firstFx || 0);
}

function procInput(k, field, i, isFloat) {
  const wrap = el('span', {});
  const input = el('input', {
    type: 'number', step: isFloat ? 'any' : 1, value: k[field][i],
    onchange: (e) => {
      k[field][i] = isFloat ? parseFloat(e.target.value) || 0 : Math.trunc(Number(e.target.value)) || 0;
      scheduleSave('SpellVisualKit', k);
      renderColorChip();
    },
  });
  wrap.append(input);
  const chipHolder = el('span', {});
  wrap.append(chipHolder);
  function renderColorChip() {
    chipHolder.textContent = '';
    const v = k[field][i];
    if (isFloat && Number.isInteger(v) && v > 255 && v <= 0xFFFFFF) {
      chipHolder.append(el('span', {
        class: 'color-chip',
        title: '0x' + v.toString(16).padStart(6, '0').toUpperCase(),
        style: `background:#${v.toString(16).padStart(6, '0')}`,
      }));
    }
  }
  renderColorChip();
  return wrap;
}

function shakeField(k) {
  const opts = [['0', 'none'], ...tbl('SpellEffectCameraShakes').map((s) => [String(s.ID), `#${s.ID} (shakes ${s.CameraShake.filter(Boolean).join(', ') || '—'})`])];
  return selectField(k, 'SpellVisualKit', 'ShakeID', 'Camera shake', opts);
}

function soundLabel(id) {
  if (!id || id <= 0) return 'none';
  const s = rec('SoundEntries', id);
  return s ? s.Name : `SoundEntries #${id}`;
}

function animLabel(id) {
  if (id === -1) return 'none';
  const a = rec('AnimationData', id);
  return a ? a.Name : (ANIM_NAMES[id] || `anim ${id}`);
}

// ▶ button that auditions whichever sound id the record field currently holds
let currentAudio = null;
function soundPlayButton(record, field) {
  return el('button', {
    class: 'linkbtn', title: 'Play this sound',
    onclick: () => {
      const id = record[field];
      if (!id || id <= 0) return toast('No sound set.');
      if (currentAudio) { currentAudio.pause(); currentAudio = null; }
      currentAudio = new Audio(`/api/sound/${id}`);
      currentAudio.play().catch((e) => toast(`Could not play sound #${id}: ${e.message}`, true));
    },
  }, '▶');
}

// --- effect editor ---

function renderEffectEditor(content, id) {
  const e = rec('SpellVisualEffectName', id);
  if (!e) { content.append(el('div', { class: 'banner' }, `SpellVisualEffectName #${id} not found.`)); return; }
  if (lab && lab.effect !== e) { lab = null; Viewer.setLabDrag(null); }
  content.append(el('div', { class: 'ed-head' },
    el('h2', {}, e.Name || '(unnamed effect)'),
    el('span', { class: 'id-badge' }, `#${e.ID}`),
    lab ? null : el('button', {
      title: 'Preview this model attached to a character and bake an XYZ/rotation/scale offset into a copy of the M2 (1.12 has no offset fields in DBC — position lives in the model file)',
      onclick: () => openLab(e),
    }, 'Position on character…')));

  if (lab && lab.effect === e) {
    content.append(el('div', { class: 'card' },
      el('h3', {}, 'Attachment lab ', el('span', { class: 'hint' }, '(shift+drag in the preview moves the model)')),
      el('div', { id: 'lab-status', class: 'ed-sub' }),
      el('div', { id: 'lab-controls' })));
    loadLabScene();
  }

  // usage
  const usedKits = tbl('SpellVisualKit').filter((k) =>
    [...KIT_SLOT_FIELDS.map(([f]) => k[f]), ...k.SpecialEffect, k.WorldEffect].includes(id));
  const usedVisuals = tbl('SpellVisual').filter((v) => v.MissileModel === id || v.AreaModel === id);
  if (usedKits.length || usedVisuals.length) {
    content.append(el('div', { class: 'ed-sub' },
      `Used by ${usedKits.length} kit(s)` , usedVisuals.length ? `, ${usedVisuals.length} visual(s) as missile/area model` : '', ' — ',
      ...usedKits.slice(0, 6).flatMap((k, i) => [i ? ', ' : '', el('a', { class: 'linkbtn', onclick: () => select('kit', k.ID, [crumbFor(state.selection)]) }, `kit #${k.ID}`)]),
      usedKits.length > 6 ? ` … +${usedKits.length - 6}` : ''));
  }

  const fileField = textField(e, 'SpellVisualEffectName', 'FileName', 'Model file', { mono: true, wide: true, after: () => previewEffectId(e.ID) });
  fileField.querySelector('label').append(' ', el('button', {
    class: 'linkbtn',
    title: 'Browse and preview every model in your archives',
    onclick: () => openModelBrowser((path) => {
      e.FileName = path;
      scheduleSave('SpellVisualEffectName', e);
      renderEditor();
    }),
  }, 'browse…'));
  content.append(el('div', { class: 'card' },
    el('h3', {}, 'Effect model'),
    el('div', { class: 'field-grid' },
      textField(e, 'SpellVisualEffectName', 'Name', 'Name', { wide: true, after: () => renderList() }),
      fileField,
      numField(e, 'SpellVisualEffectName', 'AreaEffectSize', 'Area effect size'),
      numField(e, 'SpellVisualEffectName', 'Scale', 'Scale', { float: true }))));

  if (!lab) previewEffectId(id);
}

// ---------- create-and-assign helpers ----------

// Blank kits should use -1 ("none") in effect/proc slots, matching the data convention.
const NEW_KIT_DEFAULTS = {
  KitType: 0, AnimID: 32, // SpellCast
  HeadEffect: -1, ChestEffect: -1, BaseEffect: -1,
  LeftHandEffect: -1, RightHandEffect: -1, BreathEffect: -1,
  SpecialEffect: [-1, -1, -1], WorldEffect: -1,
  SoundID: 0, ShakeID: 0, CharProc: [-1, -1, -1, -1],
};

async function createLinkedRecord(table, defaults) {
  const recNew = await api(`/api/table/${table}`, { method: 'POST', body: {} });
  if (defaults) {
    Object.assign(recNew, JSON.parse(JSON.stringify(defaults)));
    await api(`/api/table/${table}/${recNew.ID}`, { method: 'PUT', body: recNew });
  }
  await loadTable(table);
  buildDatalists();
  refreshStatus();
  return recNew.ID;
}

// ---------- deep clone ----------

async function cloneChain(visualId, spellId, spellSlot) {
  try {
    const r = await api('/api/clone-visual-chain', {
      method: 'POST',
      body: { visualId, spellId, spellSlot },
    });
    await Promise.all([loadTable('SpellVisual'), loadTable('SpellVisualKit'), loadTable('SpellVisualEffectName')]);
    buildDatalists();
    refreshStatus();
    const newId = r.visual[visualId];
    const nKits = Object.keys(r.kits).length, nFx = Object.keys(r.effects).length;
    toast(`Cloned visual #${visualId} → #${newId} (${nKits} kit${nKits === 1 ? '' : 's'}, ${nFx} effect${nFx === 1 ? '' : 's'})${spellId != null ? `, assigned to spell #${spellId}` : ''}`);
    if (spellId != null) renderEditor();
    else select('visual', newId);
    renderList();
  } catch (e) {
    toast('Clone chain failed: ' + e.message, true);
  }
}

// ---------- attachment lab ----------

let lab = null; // { effect, charPath, charGeom, attachIdx, attachId, anchor, off, yaw, pitch, roll, scale }
const charGeomCache = new Map();

async function fetchModel(path) {
  return api(`/api/model?path=${encodeURIComponent(path)}`);
}

// Which attachment the client uses for each kit slot (fallbacks for models
// lacking the primary id).
const SLOT_ANCHORS = {
  HeadEffect: [11, 20], ChestEffect: [34, 15], BaseEffect: [19, 0],
  LeftHandEffect: [21, 2], RightHandEffect: [22, 1], BreathEffect: [17],
  SpecialEffect: [19, 0], WorldEffect: [19, 0],
};

// Find where an effect is anchored by looking up its usage in kits/visuals.
function findEffectAnchor(effectId) {
  for (const k of tbl('SpellVisualKit')) {
    for (const [f, label] of KIT_SLOT_FIELDS) {
      if (k[f] === effectId) return { label: `${label} slot of kit #${k.ID}`, ids: SLOT_ANCHORS[f] };
    }
    const si = k.SpecialEffect.indexOf(effectId);
    if (si >= 0) return { label: `Special ${si + 1} slot of kit #${k.ID}`, ids: SLOT_ANCHORS.SpecialEffect };
    if (k.WorldEffect === effectId) return { label: `World slot of kit #${k.ID}`, ids: SLOT_ANCHORS.WorldEffect };
  }
  for (const v of tbl('SpellVisual')) {
    if (v.MissileModel === effectId) return { label: `missile model of visual #${v.ID}`, ids: [34, 15] };
    if (v.AreaModel === effectId) return { label: `area model of visual #${v.ID}`, ids: [19, 0] };
  }
  return { label: null, ids: [34, 15, 12] };
}

async function openLab(effect) {
  const charPath = (lab && lab.charPath) || CHAR_MODELS[0];
  lab = {
    effect, charPath, attachIdx: 0, attachId: null, anchor: findEffectAnchor(effect.ID),
    off: [0, 0, 0], yaw: 0, pitch: 0, roll: 0, scale: 1, charGeom: null, effectGeom: null,
  };
  renderEditor();
}

async function loadLabScene() {
  if (!lab) return;
  const my = lab;
  const status = document.getElementById('lab-status');
  try {
    if (!charGeomCache.has(my.charPath)) {
      if (status) status.textContent = `Loading ${my.charPath}…`;
      charGeomCache.set(my.charPath, await fetchModel(my.charPath));
    }
    my.charGeom = charGeomCache.get(my.charPath);
    if (status) status.textContent = 'Loading effect model…';
    my.effectGeom = await fetchModel(my.effect.FileName);
    if (lab !== my) return;
    // default attachment: the user's previous pick, else the detected anchor slot
    const atts = my.charGeom.attachments || [];
    let idx = my.attachId != null ? atts.findIndex((a) => a.id === my.attachId) : -1;
    if (idx < 0) {
      for (const want of my.anchor.ids) {
        const i = atts.findIndex((a) => a.id === want);
        if (i >= 0) { idx = i; break; }
      }
    }
    my.attachIdx = Math.max(0, idx);
    renderLabControls();
    Viewer.showComposite([
      { geom: my.charGeom, gray: true, noParticles: true },
      { geom: my.effectGeom, transform: labTransform() },
    ]);
    populateAnimSelect(my.charGeom); // footer anim selector drives the mannequin
    // effect textures (model index 1)
    (my.effectGeom.textures || []).forEach(async (t, i) => {
      if (!t.fileName) return;
      try {
        const res = await fetch(`/api/texture?path=${encodeURIComponent(t.fileName)}`);
        if (!res.ok || lab !== my) return;
        const w = Number(res.headers.get('X-Width')), h = Number(res.headers.get('X-Height'));
        const rgba = new Uint8Array(await res.arrayBuffer());
        if (lab === my && w && h && rgba.length === w * h * 4) Viewer.setModelTexture(1, i, w, h, rgba);
      } catch (e2) { /* untextured */ }
    });
    Viewer.setLabDrag((delta) => {
      if (!lab) return;
      lab.off[0] += delta[0]; lab.off[1] += delta[1]; lab.off[2] += delta[2];
      labChanged(true);
    });
    $('#preview-title').textContent = `Attachment lab — ${my.effect.Name || my.effect.FileName}`;
    $('#preview-msg').textContent = 'Drag arrows = move on one axis. Shift+drag = free move. Drag = orbit. Right-drag = pan camera. Offsets are relative to the chosen attachment point.';
    setOverlay(null);
    if (status) status.textContent = '';
  } catch (e) {
    if (status) status.textContent = `Failed to load: ${e.message}`;
  }
}

function labTransform() {
  const atts = (lab.charGeom && lab.charGeom.attachments) || [];
  const base = atts[lab.attachIdx] ? atts[lab.attachIdx].pos : [0, 0, 0];
  return {
    offset: [base[0] + lab.off[0], base[1] + lab.off[1], base[2] + lab.off[2]],
    yaw: lab.yaw, pitch: lab.pitch, roll: lab.roll, scale: lab.scale,
  };
}

function labChanged(syncInputs) {
  if (!lab || !lab.charGeom) return;
  Viewer.setTransform(1, labTransform());
  if (syncInputs) {
    for (const [id, val] of [['lab-x', lab.off[0]], ['lab-y', lab.off[1]], ['lab-z', lab.off[2]]]) {
      const inp = document.getElementById(id);
      if (inp) inp.value = val.toFixed(3);
    }
  }
}

function renderLabControls() {
  const wrap = document.getElementById('lab-controls');
  if (!wrap || !lab) return;
  wrap.textContent = '';
  const my = lab;
  const num = (id, label, get, set, step) => el('div', { class: 'fld' },
    el('label', {}, label),
    el('input', {
      id, type: 'number', step: step || '0.05', value: typeof get === 'number' ? get : get(), class: 'mono',
      oninput: (e) => { set(parseFloat(e.target.value) || 0); labChanged(false); },
    }));
  const atts = (my.charGeom && my.charGeom.attachments) || [];
  const attSel = el('select', {
    onchange: (e) => {
      my.attachIdx = Number(e.target.value);
      my.attachId = atts[my.attachIdx] ? atts[my.attachIdx].id : null;
      labChanged(true);
    },
  }, ...atts.map((a, i) => {
    const o = el('option', { value: i }, `${a.id} — ${ATTACH_POINTS[a.id] || 'attachment ' + a.id}`);
    if (i === my.attachIdx) o.selected = true;
    return o;
  }));
  const charSel = el('select', {
    onchange: (e) => { my.charPath = e.target.value; loadLabScene(); },
  }, ...CHAR_MODELS.map((p) => {
    const o = el('option', { value: p }, p.split('\\')[1] + ' ' + p.split('\\')[2]);
    if (p === my.charPath) o.selected = true;
    return o;
  }));
  const deg = Math.PI / 180;
  wrap.append(
    el('div', { class: 'field-grid' },
      el('div', { class: 'fld' }, el('label', {}, 'Reference character'), charSel),
      el('div', { class: 'fld' }, el('label', {}, 'Attachment point'), attSel),
      num('lab-x', 'Offset X (+forward)', () => my.off[0], (v) => { my.off[0] = v; }),
      num('lab-y', 'Offset Y (+left)', () => my.off[1], (v) => { my.off[1] = v; }),
      num('lab-z', 'Offset Z (+up)', () => my.off[2], (v) => { my.off[2] = v; }),
      num('lab-scale', 'Scale', () => my.scale, (v) => { my.scale = v || 1; }),
      num('lab-yaw', 'Yaw °', () => my.yaw / deg, (v) => { my.yaw = v * deg; }, '5'),
      num('lab-pitch', 'Pitch °', () => my.pitch / deg, (v) => { my.pitch = v * deg; }, '5'),
      num('lab-roll', 'Roll °', () => my.roll / deg, (v) => { my.roll = v * deg; }, '5')),
    el('div', { class: 'ed-sub', style: 'margin-top:8px' },
      my.anchor.label
        ? `Anchor detected: this effect is used as the ${my.anchor.label} — the attachment point defaulted to match. The exported model bakes only your offset, so in game it lands the same way relative to that attachment.`
        : 'This effect is not referenced by any kit or visual yet — attachment defaulted to Chest. The exported model bakes only your offset relative to the chosen attachment.'));

  const baseName = (my.effect.FileName || 'model').split('\\').pop().replace(/\.(mdx|mdl|m2)$/i, '');
  const outInput = el('input', {
    type: 'text', class: 'mono', value: `Custom\\${baseName}_pos.m2`, style: 'width: 320px',
  });
  wrap.append(el('div', { style: 'margin-top: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap' },
    el('label', {}, 'Export as '), outInput,
    el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          const r = await api('/api/bake-m2', {
            method: 'POST',
            body: {
              sourcePath: my.effect.FileName,
              outPath: outInput.value,
              offset: my.off, yaw: my.yaw, pitch: my.pitch, roll: my.roll, scale: my.scale,
            },
          });
          my.effect.FileName = r.outPath;
          scheduleSave('SpellVisualEffectName', my.effect);
          toast(`Baked ${r.bytes} bytes → gamedata\\${r.outPath} and set as this effect's model. Pack it with "Download patch MPQ".`);
          lab = null;
          Viewer.setLabDrag(null);
          renderEditor();
        } catch (e) { toast('Bake failed: ' + e.message, true); }
      },
    }, 'Bake & apply to effect'),
    el('a', { class: 'linkbtn', href: '/api/export-patch', download: '' }, 'Download patch MPQ'),
    el('button', { onclick: () => { lab = null; Viewer.setLabDrag(null); renderEditor(); } }, 'Close lab')));
}

// ---------- spell storyboard ----------
// Plays the full visual sequence on a caster + target pair: precast (while
// casting) → cast → missile flight → impact → state aura, with kit anims,
// sounds and camera-visible effect models per phase.

let story = null;

// Storyboard actors: the default Human Male player model — full animation set
// including the vanilla spell-cast sequences — with its body skin resolved
// server-side so it renders textured rather than blank white.
const STORY_CHAR = 'Character\\Human\\Male\\HumanMale.m2';

// Vanilla character animation IDs (AnimationData.dbc): spell cast/ready differ
// from later expansions. Directed = aimed at a target, Omni = self/AoE.
const ANIM = {
  stand: 0, standWound: 8,
  readySpellDirected: 51, readySpellOmni: 52,
  spellCastDirected: 53, spellCastOmni: 54,
};

function stopStoryboard() {
  if (story) {
    cancelAnimationFrame(story.raf);
    story = null;
    Viewer.setPanEnabled(false);
  }
}

const KIT_SLOT_ATTACH = {
  HeadEffect: [11, 20], ChestEffect: [34, 15], BaseEffect: [19, 0],
  LeftHandEffect: [21, 2], RightHandEffect: [22, 1], BreathEffect: [17],
};

function attachPosOf(charGeom, ids) {
  return attachInfoOf(charGeom, ids).pos;
}

function attachInfoOf(charGeom, ids) {
  for (const id of ids) {
    const a = (charGeom.attachments || []).find((x) => x.id === id);
    if (a) return { pos: a.pos, bone: a.bone };
  }
  return { pos: [0, 0, 1], bone: -1 };
}

function seqIndexForAnim(charGeom, animIds) {
  const seqs = (charGeom.skeleton && charGeom.skeleton.sequences) || [];
  for (const id of animIds) {
    const i = seqs.findIndex((s) => s.id === id && s.end > s.start);
    if (i >= 0) return i;
  }
  return seqs.findIndex((s) => s.id === 0);
}

async function fetchTexturesFor(mi, geom) {
  (geom.textures || []).forEach(async (t, i) => {
    if (!t.fileName) return;
    try {
      const res = await fetch(`/api/texture?path=${encodeURIComponent(t.fileName)}`);
      if (!res.ok) return;
      const w = Number(res.headers.get('X-Width')), h = Number(res.headers.get('X-Height'));
      const rgba = new Uint8Array(await res.arrayBuffer());
      if (w && h && rgba.length === w * h * 4) Viewer.setModelTexture(mi, i, w, h, rgba);
    } catch (e2) { /* untextured */ }
  });
}

async function openStoryboard(visualId, spell) {
  stopStoryboard();
  const v = rec('SpellVisual', visualId);
  if (!v) return toast(`SpellVisual #${visualId} not found.`, true);

  let castTime = 2000;
  let speed = spell && spell.Speed > 0 ? spell.Speed : 20;
  // Actors are kept close (5yd) so the whole exchange stays readable in frame;
  // real ranges get too spread out to see the action. Range only decides whether
  // it's a self-cast (single actor) vs. caster→target.
  let DIST = 5, rangeNote = '5yd';
  if (spell) {
    const ct = rec('SpellCastTimes', spell.CastingTimeIndex);
    if (ct && ct.Base > 0) castTime = ct.Base;
    const range = rec('SpellRange', spell.RangeIndex);
    if (range && range.RangeMax === 0) {
      DIST = 0; // self-cast: everything lands on the caster
      rangeNote = 'self-cast';
    } else if (range) {
      rangeNote = `range ${range.RangeMax}yd (shown at 5)`;
    }
  }
  castTime = Math.max(1200, castTime);
  const selfCast = DIST === 0;

  const charPath = STORY_CHAR;
  if (!charGeomCache.has(charPath)) charGeomCache.set(charPath, await fetchModel(charPath));
  const cg = charGeomCache.get(charPath);

  const kits = { precast: v.PrecastKit, cast: v.CastKit, impact: v.ImpactKit, state: v.StateKit };
  const fx = [];
  for (const [phase, kid] of Object.entries(kits)) {
    const k = kid > 0 ? rec('SpellVisualKit', kid) : null;
    if (!k) continue;
    const tgt = phase === 'impact' || phase === 'state' ? 'target' : 'caster';
    for (const [f] of KIT_SLOT_FIELDS) {
      if (k[f] > 0) fx.push({ phase, tgt, effectId: k[f], attachIds: KIT_SLOT_ATTACH[f] || [19, 0] });
    }
    for (const e2 of k.SpecialEffect) if (e2 > 0) fx.push({ phase, tgt, effectId: e2, attachIds: [19, 0] });
    if (k.WorldEffect > 0) fx.push({ phase, tgt, effectId: k.WorldEffect, attachIds: [19, 0] });
  }

  const geomCache = new Map();
  const fxGeom = async (effectId) => {
    const e2 = rec('SpellVisualEffectName', effectId);
    if (!e2 || !e2.FileName) return null;
    if (!geomCache.has(effectId)) {
      try { geomCache.set(effectId, await fetchModel(e2.FileName)); }
      catch (err) { geomCache.set(effectId, null); }
    }
    return geomCache.get(effectId);
  };

  const casterPos = [0, 0, 0], targetPos = selfCast ? casterPos : [DIST, 0, 0];
  const items = [
    { geom: cg, noParticles: true, transform: { offset: casterPos } },
  ];
  if (!selfCast) items.push({ geom: cg, noParticles: true, transform: { offset: targetPos, yaw: Math.PI } });
  const targetMi = selfCast ? 0 : 1;
  const fxModels = [];
  for (const f of fx.slice(0, 10)) {
    const g = await fxGeom(f.effectId);
    if (!g || (g.particleOnly && !(g.particles || []).length)) continue;
    const base = f.tgt === 'caster' ? casterPos : targetPos;
    const info = attachInfoOf(cg, f.attachIds);
    const hostMi = f.tgt === 'caster' ? 0 : targetMi;
    const yaw = f.tgt === 'target' && !selfCast ? Math.PI : 0;
    const rp = yaw ? [-info.pos[0], -info.pos[1], info.pos[2]] : info.pos;
    items.push({
      geom: g, visible: false,
      transform: { offset: [base[0] + rp[0], base[1] + rp[1], base[2] + rp[2]], yaw },
      // ride the host's animated attachment bone (hands raise → effect follows)
      follow: { host: hostMi, bone: info.bone, pos: info.pos, yaw },
    });
    fxModels.push({ mi: items.length - 1, phase: f.phase });
  }

  let missileMi = -1, missileStart = null, missileEnd = null;
  if (v.MissileModel > 0 && !selfCast) {
    const g = await fxGeom(v.MissileModel);
    if (g) {
      const ap = attachPosOf(cg, [34, 15]);
      missileStart = [casterPos[0] + ap[0], casterPos[1] + ap[1], casterPos[2] + ap[2]];
      missileEnd = [targetPos[0] - ap[0], targetPos[1] - ap[1], targetPos[2] + ap[2]];
      items.push({ geom: g, visible: false, transform: { offset: missileStart.slice() } });
      missileMi = items.length - 1;
    }
  }

  Viewer.showComposite(items);
  Viewer.setPanEnabled(true);
  populateAnimSelect(null);
  items.forEach((it, mi) => { if (!it.gray) fetchTexturesFor(mi, it.geom); });

  const kitSound = (kid) => {
    const k = kid > 0 ? rec('SpellVisualKit', kid) : null;
    if (k && k.SoundID > 0) new Audio(`/api/sound/${k.SoundID}`).play().catch(() => {});
  };
  const setChar = (mi, animIds) => {
    const i = seqIndexForAnim(cg, animIds);
    if (i >= 0) Viewer.setAnimation(mi, i);
  };
  const kitAnim = (kid, fallback) => {
    const k = kid > 0 ? rec('SpellVisualKit', kid) : null;
    return k && k.AnimID > 0 ? [k.AnimID, ...fallback] : fallback;
  };

  const flightMs = (DIST / speed) * 1000;
  const T_cast = castTime;
  const T_impact = T_cast + (missileMi >= 0 ? flightMs : 300);
  const T_state = T_impact + 1500;
  const T_end = T_state + (kits.state > 0 ? 3000 : 800);
  const T_loop = T_end + 600;
  const showPhase = (phase, on) => {
    for (const f of fxModels) if (f.phase === phase) Viewer.setVisible(f.mi, on);
  };

  $('#preview-title').textContent = `Storyboard — visual #${visualId}${spell ? ` (${spell.Name.enUS})` : ''}`;
  $('#preview-stats').textContent = `${fxModels.length} effect model(s)${missileMi >= 0 ? ' + missile' : ''}`;
  const msg = $('#preview-msg');
  setOverlay(null);

  const st = { t0: performance.now(), phase: '', raf: 0 };
  story = st;
  const enter = (phase) => {
    if (st.phase === phase) return;
    st.phase = phase;
    msg.textContent = `▶ ${phase} — cast ${Math.round(castTime)}ms · ${rangeNote}` +
      (missileMi >= 0 ? ` · missile ${speed.toFixed(0)} yd/s (${Math.round(flightMs)}ms)` : '') + ' · loops';
    // directed animations for targeted spells, omni for self-cast
    const readyAnim = selfCast ? [ANIM.readySpellOmni, ANIM.readySpellDirected, ANIM.stand]
      : [ANIM.readySpellDirected, ANIM.readySpellOmni, ANIM.stand];
    const castAnim = selfCast ? [ANIM.spellCastOmni, ANIM.spellCastDirected, ANIM.stand]
      : [ANIM.spellCastDirected, ANIM.spellCastOmni, ANIM.stand];
    if (phase === 'precast') {
      showPhase('state', false); showPhase('impact', false); showPhase('cast', false);
      showPhase('precast', true);
      setChar(0, kitAnim(kits.precast, readyAnim));
      if (!selfCast) setChar(targetMi, [ANIM.stand]);
      kitSound(kits.precast);
    } else if (phase === 'cast') {
      showPhase('precast', false);
      showPhase('cast', true);
      setChar(0, kitAnim(kits.cast, castAnim));
      kitSound(kits.cast);
      if (missileMi >= 0) Viewer.setVisible(missileMi, true);
      if (v.MissileSound > 0) new Audio(`/api/sound/${v.MissileSound}`).play().catch(() => {});
    } else if (phase === 'impact') {
      showPhase('cast', false);
      if (missileMi >= 0) Viewer.setVisible(missileMi, false);
      showPhase('impact', true);
      setChar(0, [ANIM.stand]);
      if (!selfCast) setChar(targetMi, [ANIM.standWound, ANIM.stand]); // damage flinch
      kitSound(kits.impact);
    } else if (phase === 'state') {
      showPhase('impact', false);
      showPhase('state', true);
      setChar(targetMi, [ANIM.stand]);
      kitSound(kits.state);
    } else if (phase === 'rest') {
      showPhase('state', false);
    }
  };
  const tick = (now) => {
    if (story !== st) return;
    const t = (now - st.t0) % T_loop;
    if (t < T_cast) enter('precast');
    else if (t < T_impact) {
      enter('cast');
      if (missileMi >= 0) {
        const p = Math.min(1, (t - T_cast) / flightMs);
        const arc = v.MissilePathType === 1 ? 2 : v.MissilePathType === 2 ? 5 : 0;
        Viewer.setTransform(missileMi, {
          offset: [
            missileStart[0] + (missileEnd[0] - missileStart[0]) * p,
            missileStart[1] + (missileEnd[1] - missileStart[1]) * p,
            missileStart[2] + (missileEnd[2] - missileStart[2]) * p + Math.sin(Math.PI * p) * arc,
          ],
        }, { keepParticles: true });
      }
    } else if (t < T_state) enter('impact');
    else if (t < T_end) enter('state');
    else enter('rest');
    st.raf = requestAnimationFrame(tick);
  };
  st.raf = requestAnimationFrame(tick);
}

// ---------- model browser ----------

// Browse every model in the archives/loose files; onPick(path) applies the choice.
function openModelBrowser(onPick) {
  const state2 = { q: '', dir: '', offset: 0, total: 0, selected: null };
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  const listEl = el('div', { class: 'model-list' });
  const countEl = el('span', { class: 'sub' });
  const dirSel = el('select', { onchange: (e) => { state2.dir = e.target.value; load(false); } },
    el('option', { value: '' }, 'all folders'));
  const searchInput = el('input', {
    type: 'search', placeholder: 'Search models… (e.g. barrel, missile, totem)', autocomplete: 'off',
    oninput: (e) => {
      clearTimeout(searchInput._t);
      searchInput._t = setTimeout(() => { state2.q = e.target.value; load(false); }, 200);
    },
  });
  const useBtn = el('button', {
    class: 'primary', disabled: true,
    onclick: () => { if (state2.selected) { onPick(state2.selected); close(); } },
  }, 'Use selected model');
  const moreBtn = el('button', { onclick: () => load(true), hidden: true }, 'Load more…');

  const modal = el('div', { class: 'modal' },
    el('div', { class: 'modal-head' },
      el('b', {}, 'Browse models'),
      countEl,
      el('span', { class: 'spacer' }),
      el('button', { onclick: close }, '✕')),
    el('div', { class: 'modal-toolbar' }, searchInput, dirSel),
    listEl,
    el('div', { class: 'modal-foot' },
      el('span', { class: 'sub' }, 'Click = 3D preview · double-click = use'),
      el('span', { class: 'spacer' }),
      moreBtn, useBtn));
  backdrop.append(modal);
  document.body.append(backdrop);
  searchInput.focus();

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  let dirsLoaded = false;
  async function load(append) {
    if (!append) { state2.offset = 0; listEl.textContent = ''; }
    else state2.offset += 200;
    try {
      const data = await api(`/api/models?q=${encodeURIComponent(state2.q)}&dir=${encodeURIComponent(state2.dir)}&offset=${state2.offset}&limit=200`);
      state2.total = data.total;
      countEl.textContent = ` ${data.total} model${data.total === 1 ? '' : 's'}`;
      if (!dirsLoaded) {
        dirsLoaded = true;
        for (const d of data.dirs) dirSel.append(el('option', { value: d.name }, `${d.name} (${d.count})`));
      }
      for (const f of data.records) {
        const row = el('div', { class: 'model-row' },
          el('span', { class: 'nm mono' }, f.path),
          el('span', { class: 'sub' }, `${(f.size / 1024).toFixed(0)} KB · ${f.archive}`));
        row.addEventListener('click', () => {
          listEl.querySelectorAll('.model-row.selected').forEach((n) => n.classList.remove('selected'));
          row.classList.add('selected');
          state2.selected = f.path;
          useBtn.disabled = false;
          previewModelPath(f.path);
        });
        row.addEventListener('dblclick', () => { onPick(f.path); close(); });
        listEl.append(row);
      }
      moreBtn.hidden = state2.offset + 200 >= data.total;
    } catch (e) {
      listEl.append(el('div', { class: 'banner' }, `Failed to list models: ${e.message}`));
    }
  }
  load(false);
}

// ---------- 3D preview ----------

let previewSeq = 0;
// These messages used to render in an overlay stretched across the canvas.
// That element set `display: flex`, which beats the `hidden` attribute's
// `display: none` — so its rgba(10,12,15,.55) scrim sat over every preview
// permanently and dimmed every model by 45%. The overlay is gone; the text now
// goes to the status line under the canvas, where nothing covers the render.
function setOverlay(html) {
  if (html == null) return; // callers set their own status text on success
  $('#preview-msg').innerHTML = html;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
async function previewEffectId(id) {
  const seq = ++previewSeq;
  const title = $('#preview-title'), msg = $('#preview-msg'), stats = $('#preview-stats');
  if (!id || id <= 0) {
    Viewer.clear();
    title.textContent = 'Model preview';
    stats.textContent = '';
    msg.textContent = 'No effect selected.';
    setOverlay('<div>No effect selected — pick an effect slot to preview its model.</div>');
    return;
  }
  const e = rec('SpellVisualEffectName', id);
  if (!e) {
    Viewer.clear();
    title.textContent = `effect #${id}`;
    msg.textContent = 'Effect record not found.';
    setOverlay('<div>Effect record not found.</div>');
    return;
  }
  title.textContent = e.Name || e.FileName;
  await previewModelPath(e.FileName, { seq, keepTitle: true });
}

// Fill the preview footer's animation selector for scene model 0.
function populateAnimSelect(geom) {
  const lbl = $('#lbl-anim'), sel = $('#sel-anim');
  const seqs = geom && geom.skeleton && geom.skeleton.sequences || [];
  if (!seqs.length) { lbl.hidden = true; sel.textContent = ''; return; }
  sel.textContent = '';
  sel.append(el('option', { value: -1 }, 'bind pose'));
  seqs.forEach((s, i) => {
    const o = el('option', { value: i },
      `${animLabel(s.id)}${s.variationIndex ? ` #${s.variationIndex}` : ''} (${((s.end - s.start) / 1000).toFixed(1)}s)`);
    sel.append(o);
  });
  sel.value = String(Viewer.getAnimation(0));
  sel.onchange = () => Viewer.setAnimation(0, Number(sel.value));
  lbl.hidden = false;
}

// Load + show a model by raw game path (shared by effect preview and the browser).
async function previewModelPath(filePath, opts = {}) {
  const seq = opts.seq != null ? opts.seq : ++previewSeq;
  const title = $('#preview-title'), msg = $('#preview-msg'), stats = $('#preview-stats');
  if (!opts.keepTitle) title.textContent = String(filePath).split('\\').pop();
  msg.textContent = 'Loading model…';
  stats.textContent = '';
  try {
    const geom = await api(`/api/model?path=${encodeURIComponent(filePath)}`);
    if (seq !== previewSeq) return;
    const emitters = (geom.particles || []).length;
    if (geom.particleOnly && !emitters) {
      Viewer.clear();
      stats.textContent = '';
      setOverlay(`<div><b>No previewable content.</b><br><code>${escapeHtml(filePath)} → ${escapeHtml(geom.file)}</code><br><br>` +
        'This model has no mesh and no readable particle emitters.</div>');
      return;
    }
    Viewer.show(geom);
    setOverlay(null);
    populateAnimSelect(geom);
    const texNames = (geom.textures || []).map((t) => t.fileName).filter(Boolean);
    const parts = [];
    if (geom.vertexCount) parts.push(`${geom.vertexCount} verts / ${geom.indices.length / 3} tris`);
    if (emitters) parts.push(`${emitters} emitter${emitters > 1 ? 's' : ''}`);
    if (geom.skeleton && geom.skeleton.sequences.length) parts.push(`${geom.skeleton.sequences.length} anims`);
    if (texNames.length) parts.push(`${texNames.length} tex`);
    stats.textContent = parts.join(' / ');
    msg.textContent = `${filePath} → ${geom.file}${geom.particleOnly ? ' (particles only — approximate preview)' : ''}`;
    // fetch and apply BLP textures asynchronously
    (geom.textures || []).forEach(async (t, i) => {
      if (!t.fileName) return;
      try {
        const res = await fetch(`/api/texture?path=${encodeURIComponent(t.fileName)}`);
        if (!res.ok || seq !== previewSeq) return;
        const w = Number(res.headers.get('X-Width')), h = Number(res.headers.get('X-Height'));
        const rgba = new Uint8Array(await res.arrayBuffer());
        if (seq !== previewSeq || !w || !h || rgba.length !== w * h * 4) return;
        Viewer.setTexture(i, w, h, rgba);
      } catch (e2) { /* keep untextured */ }
    });
  } catch (err) {
    if (seq !== previewSeq) return;
    Viewer.clear();
    if (err.status === 404 && err.data && err.data.archives && err.data.archives.length) {
      setOverlay(`<div><b>Model not found in your archives:</b><br><code>${escapeHtml(filePath)}</code> — ${escapeHtml(err.message)}<br><br>` +
        `Searched: <code>${escapeHtml(err.data.archives.join(', '))}</code></div>`);
    } else if (err.status === 404) {
      setOverlay(`<div><b>No game models found.</b><br>The DBC only stores the model path:<br><code>${escapeHtml(filePath)}</code><br><br>` +
        'Copy your 1.12.1 client’s <code>model.MPQ</code>, <code>patch.MPQ</code> and <code>patch-2.MPQ</code> ' +
        'into <code>gamedata/</code> at the project root (the whole <code>Data</code> folder works too), then press <b>Reload from disk</b>.</div>');
    } else {
      setOverlay(`<div><b>Could not parse model:</b><br><code>${escapeHtml(filePath)}</code><br>${escapeHtml(err.message)}</div>`);
    }
  }
}

function previewForVisualId(vid) {
  const v = vid > 0 ? rec('SpellVisual', vid) : null;
  if (!v) { previewEffectId(0); return; }
  if (v.HasMissile && v.MissileModel > 0) return previewEffectId(v.MissileModel);
  for (const [field] of VISUAL_KIT_SLOTS) {
    const fx = firstKitEffect(v[field]);
    if (fx) return previewEffectId(fx);
  }
  previewEffectId(0);
}

// ---------- toolbar actions ----------

$('#btn-save').addEventListener('click', () => openFileDialog());
$('#btn-undo').addEventListener('click', () => doUndoRedo('undo'));
$('#btn-redo').addEventListener('click', () => doUndoRedo('redo'));
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  // let text fields keep their native input-level undo
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); doUndoRedo('undo'); }
  else if (e.key === 'y' || (e.key === 'z' && e.shiftKey) || e.key === 'Z') { e.preventDefault(); doUndoRedo('redo'); }
});

// Discard in-memory edits to specific tables (server reloads them from
// disk/archives), then refresh everything client-side.
async function discardTables(names, closeDialog) {
  try {
    const r = await api('/api/discard', { method: 'POST', body: { tables: names } });
    for (const n of r.discarded) {
      if (state.tables[n]) await loadTable(n);
    }
    buildDatalists();
    await refreshStatus();
    renderList();
    renderEditor();
    if (closeDialog) closeDialog();
    if (r.failed.length) {
      toast(`Discarded ${r.discarded.join(', ') || 'nothing'}; failed: ${r.failed.map((f) => `${f.name} (${f.error})`).join(', ')}`, true);
    } else {
      toast(`Discarded changes to ${r.discarded.join(', ')}.`);
    }
  } catch (e) {
    toast('Discard failed: ' + e.message, true);
  }
}

// ---------- save / export dialog ----------

async function openFileDialog() {
  await refreshStatus();
  const dirty = (state.status && state.status.dirty) || [];
  const tables = (state.status && state.status.tables) || {};
  const loaded = Object.keys(tables).filter((n) => tables[n].state === 'ok');
  const mysqlTables = (state.status && state.status.mysqlTables) || [];
  const clientDir = (state.status && state.status.clientDir) || null;
  const dirtyMysql = dirty.filter((n) => mysqlTables.includes(n));
  const dirtyFile = dirty.filter((n) => !mysqlTables.includes(n));

  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  const section = (title, hint, ...children) => el('div', { class: 'dlg-section' },
    el('h3', {}, title),
    hint ? el('div', { class: 'sub dlg-hint' }, hint) : null,
    ...children);

  // --- section: save to project dbc/ folder ---
  // With MySQL paired, its tables flush to the shared database; any other dirty
  // tables still write to dbc/. The confirm spells out exactly where each goes.
  const saveBtn = el('button', {
    class: 'primary', disabled: dirty.length === 0,
    onclick: async () => {
      const parts = [];
      if (dirtyMysql.length) parts.push(`${dirtyMysql.length} to MySQL (${dirtyMysql.join(', ')})`);
      if (dirtyFile.length) parts.push(`${dirtyFile.length} to dbc/ (${dirtyFile.join(', ')})`);
      if (!confirm(`Save changes?\n\n${parts.join('\n')}\n\ndbc/ files are backed up to dbc/backup/<timestamp>/ first.`)) return;
      try {
        const r = await api('/api/save', { method: 'POST' });
        const bits = [];
        if (r.mysql && r.mysql.saved.length) bits.push(`MySQL: ${r.mysql.saved.map((s) => `${s.table} (${s.upserted}↑${s.deleted ? ' ' + s.deleted + '✕' : ''})`).join(', ')}`);
        if (r.saved.length) bits.push(`dbc/: ${r.saved.join(', ')}`);
        toast(bits.join(' · ') || 'Nothing to save');
        refreshStatus();
        close();
      } catch (e2) { toast('Save failed: ' + e2.message, true); }
    },
  }, dirty.length ? `Save ${dirty.length} modified table(s)` : 'No unsaved changes');

  const discardAllBtn = el('button', {
    class: 'danger', disabled: dirty.length === 0, style: 'margin-left:8px',
    onclick: () => {
      if (!confirm(`Discard ALL unsaved changes?\n\n${dirty.map((d) => d + '.dbc').join('\n')}\n\nEach table is reloaded from its last saved state. This cannot be undone.`)) return;
      discardTables(dirty, close);
    },
  }, dirty.length ? `Discard all changes` : 'Nothing to discard');

  // --- section: download DBCs ---
  const dbcRows = loaded.map((n) => el('div', { class: 'dlg-row' },
    el('span', { class: 'nm mono' }, `${n}.dbc`),
    dirty.includes(n) ? el('span', { class: 'dlg-dirty' }, '● modified') : el('span', { class: 'sub' }, 'unchanged'),
    el('span', { class: 'sub' }, `${tables[n].recordCount} records`),
    dirty.includes(n) ? el('button', {
      class: 'linkbtn', title: 'Throw away edits to this table and reload its last saved state',
      onclick: () => {
        if (confirm(`Discard unsaved changes to ${n}.dbc? This cannot be undone.`)) discardTables([n], close);
      },
    }, 'discard') : null,
    el('a', { class: 'linkbtn', href: `/api/export/dbc/${n}`, download: '' }, 'download')));
  const dirtySorted = [...dbcRows].sort((a, b) =>
    (b.querySelector('.dlg-dirty') ? 1 : 0) - (a.querySelector('.dlg-dirty') ? 1 : 0));

  // --- section: custom game files ---
  const looseList = el('div', {}, el('span', { class: 'sub' }, 'Loading…'));
  api('/api/loose-files').then((r) => {
    looseList.textContent = '';
    if (!r.files.length) {
      looseList.append(el('span', { class: 'sub' }, 'None yet — baked models from the attachment lab will appear here.'));
      return;
    }
    for (const f of r.files) {
      looseList.append(el('div', { class: 'dlg-row' },
        el('span', { class: 'nm mono' }, f.path),
        el('span', { class: 'sub' }, `${(f.size / 1024).toFixed(0)} KB`),
        el('a', { class: 'linkbtn', href: `/api/export/file?path=${encodeURIComponent(f.path)}`, download: '' }, 'download')));
    }
    looseList.append(el('div', { style: 'margin-top:8px' },
      el('a', { class: 'linkbtn', href: '/api/export/zip?files=all', download: '' },
        '⬇ Download all as ZIP (folder structure preserved — drag contents into Ladik’s MPQ Editor)')));
  }).catch((e2) => { looseList.textContent = `Failed to list: ${e2.message}`; });

  // --- section: patch MPQ ---
  const chkDbc = el('input', { type: 'checkbox', checked: '' });
  const patchLink = el('a', { class: 'linkbtn', href: '/api/export-patch?dbc=1', download: '' }, '⬇ Download patch MPQ');
  chkDbc.addEventListener('change', () => {
    patchLink.href = chkDbc.checked ? '/api/export-patch?dbc=1' : '/api/export-patch';
  });
  // Deploy straight into the client Data folder (only when CLIENT_DIR is set).
  const deployBtn = clientDir ? el('button', {
    style: 'margin-left:8px',
    title: `Write the patch into ${clientDir} as the next winning patch letter`,
    onclick: async () => {
      try {
        const r = await api('/api/deploy-patch', { method: 'POST', body: { dbc: chkDbc.checked } });
        toast(`Deployed ${r.name} → ${r.written} (${r.files} files${r.includedDbc ? ', DBCs included' : ''})`);
      } catch (e2) { toast('Deploy failed: ' + e2.message, true); }
    },
  }, '⤓ Deploy to client') : null;

  // --- section: import ---
  const importInput = el('input', { type: 'file', accept: '.dbc', multiple: '', style: 'display:none' });
  importInput.addEventListener('change', async () => {
    for (const file of importInput.files) {
      const name = file.name.replace(/\.dbc$/i, '');
      if (!confirm(`Import "${file.name}" (${(file.size / 1024).toFixed(0)} KB)?\n\nThis validates the file against the 1.12.1 ${name} schema, backs up the current dbc/${name}.dbc, then replaces it.`)) continue;
      try {
        const buf = await file.arrayBuffer();
        const r = await fetch(`/api/import/dbc?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || r.statusText);
        toast(`Imported ${name}.dbc — ${data.recordCount} records.`);
      } catch (e2) {
        toast(`Import of ${file.name} failed: ${e2.message}`, true);
      }
    }
    importInput.value = '';
    close();
    await boot(true);
  });

  const modal = el('div', { class: 'modal dlg' },
    el('div', { class: 'modal-head' },
      el('b', {}, 'Save / Export / Import'),
      el('span', { class: 'sub' }, dirty.length ? ` ${dirty.length} table(s) with unsaved changes` : ' no unsaved changes'),
      el('span', { class: 'spacer' }),
      el('button', { onclick: close }, '✕')),
    el('div', { class: 'dlg-body' },
      section('Save to project (dbc/ folder)',
        'Writes your edits over the .dbc files this editor loaded from. A timestamped backup of the originals is created first. Nothing is written to disk until you do this. Discarding reloads the last saved state instead.',
        saveBtn, discardAllBtn),
      section('Download DBC files',
        'Downloads reflect your current edits without touching any files on disk. For the client, DBCs belong in DBFilesClient\\ inside a patch MPQ.',
        el('div', { class: 'dlg-list' }, ...dirtySorted),
        el('div', { style: 'margin-top:8px' },
          el('a', { class: 'linkbtn', href: '/api/export/zip?dbc=dirty', download: '', hidden: dirty.length === 0 },
            '⬇ Download modified DBCs as ZIP (DBFilesClient/ structure)'))),
      section('Custom game files (baked models)',
        'Raw files with their correct in-game paths, ready for manual MPQ editing.',
        looseList),
      section('Client patch MPQ',
        clientDir
          ? `One ready-to-ship archive. Deploy writes it straight into ${clientDir} as the next winning patch letter; download to manage it yourself (e.g. in Ladik’s).`
          : 'One ready-to-ship archive for your players. (Set CLIENT_DIR to enable one-click deploy into your client.)',
        el('label', { class: 'checkrow', style: 'margin-bottom:6px' }, chkDbc, ' include modified DBCs (DBFilesClient\\)'),
        el('div', {}, patchLink, deployBtn)),
      section('Import DBC files',
        'Replace a project DBC with a file from elsewhere (e.g. a Spell.dbc edited in another tool). Validated against the 1.12.1 layout before anything is overwritten; the old file is backed up.',
        el('button', { onclick: () => importInput.click() }, 'Choose .dbc files…'),
        importInput)));
  backdrop.append(modal);
  document.body.append(backdrop);
}

$('#btn-reload').addEventListener('click', async () => {
  if (state.status && state.status.dirty.length &&
      !confirm(`Discard unsaved changes to ${state.status.dirty.join(', ')}?`)) return;
  try {
    await api('/api/reload', { method: 'POST' });
    await boot(true);
    toast('Reloaded from disk.');
  } catch (e) { toast('Reload failed: ' + e.message, true); }
});

// ---------- settings dialog ----------

async function openSettingsDialog() {
  let cfg;
  try { cfg = await api('/api/config'); }
  catch (e) { return toast('Could not load settings: ' + e.message, true); }

  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  function close() { backdrop.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  const field = (label, input, hint) => el('div', { class: 'fld' },
    el('label', {}, label), input, hint ? el('div', { class: 'subtext' }, hint) : null);
  const inp = (val, attrs = {}) => el('input', { type: 'text', class: 'mono', value: val == null ? '' : String(val), ...attrs });

  const fHost = inp(cfg.mysql.host);
  const fPort = inp(cfg.mysql.port, { type: 'number' });
  const fUser = inp(cfg.mysql.user);
  // shown in the clear, like Stoneharry — this is a local tool and the value
  // lives in a gitignored file anyway
  const fPass = inp(cfg.mysql.password, { placeholder: '(none)' });
  const fDb = inp(cfg.mysql.database, { placeholder: 'e.g. spelledit — blank = use dbc/ files' });
  const fClient = inp(cfg.clientDir, { placeholder: 'e.g. C:\\Games\\WoW 1.12.1\\Data' });

  const gather = () => ({
    mysql: {
      host: fHost.value.trim(), port: Number(fPort.value) || 3306,
      user: fUser.value.trim(), database: fDb.value.trim(),
      password: fPass.value,
    },
    clientDir: fClient.value.trim(),
  });

  const result = el('div', { class: 'subtext', style: 'margin-top:8px; white-space:pre-wrap' });
  const testBtn = el('button', {
    onclick: async () => {
      result.textContent = 'Testing…';
      try {
        const r = await api('/api/config/test', { method: 'POST', body: { mysql: gather().mysql } });
        if (!r.ok) { result.innerHTML = `<span class="err">✗ ${escapeHtml(r.error)}</span>`; return; }
        const lines = r.tables.map((t) => t.present
          ? (t.layoutOk ? `✓ ${t.table} (${t.columns} cols)` : `⚠ ${t.table} — ${escapeHtml(t.error)}`)
          : `✗ ${t.table} not found`);
        result.innerHTML = '<span class="ok-text">Connected.</span>\n' + lines.map(escapeHtml).join('\n');
      } catch (e) { result.innerHTML = `<span class="err">✗ ${escapeHtml(e.message)}</span>`; }
    },
  }, 'Test connection');

  const saveBtn = el('button', {
    class: 'primary', style: 'margin-top:12px',
    onclick: async () => {
      try {
        const r = await api('/api/config', { method: 'POST', body: gather() });
        toast(`Settings saved — backend: ${r.backend}${r.mysqlTables.length ? ` (${r.mysqlTables.join(', ')})` : ''}`);
        close();
        await boot(true);
      } catch (e) { toast('Save failed: ' + e.message, true); }
    },
  }, 'Save & Apply');

  const modal = el('div', { class: 'modal dlg' },
    el('div', { class: 'modal-head' },
      el('b', {}, '⚙ Settings'), el('span', { class: 'spacer' }),
      el('button', { onclick: close }, '✕')),
    el('div', { class: 'dlg-body' },
      el('div', { class: 'dlg-section' },
        el('h3', {}, 'Stoneharry MySQL pairing'),
        el('div', { class: 'sub dlg-hint' },
          `Point this at Stoneharry's database to share edits with no export/re-import. Leave the database blank to work on dbc/ files instead. Current backend: ${cfg.backend}.`),
        el('div', { class: 'field-grid' },
          field('Host', fHost), field('Port', fPort), field('User', fUser),
          field('Password', fPass), field('Database', fDb, 'blank = file mode')),
        el('div', { style: 'margin-top:8px' }, testBtn), result),
      el('div', { class: 'dlg-section' },
        el('h3', {}, 'WoW client Data folder'),
        el('div', { class: 'sub dlg-hint' },
          'Enables the one-click “Deploy to client” button in Save / Export. Leave blank to download patches instead.'),
        field('Client Data folder', fClient)),
      el('div', { class: 'dlg-section' },
        el('div', { class: 'sub' }, `Saved to ${escapeHtml(cfg.configPath)} (gitignored — your password never enters the repo).`),
        saveBtn)));
  backdrop.append(modal);
  document.body.append(backdrop);
}
$('#btn-settings').addEventListener('click', openSettingsDialog);

$('#btn-new').addEventListener('click', () => createRecord(false));
$('#btn-clone').addEventListener('click', () => createRecord(true));
$('#btn-delete').addEventListener('click', async () => {
  const sel = state.selection;
  if (!sel) return;
  const def = TAB_DEF[state.tab];
  if (!confirm(`Delete ${def.label} #${sel.id}? Other records referencing it are not changed.`)) return;
  try {
    await api(`/api/table/${def.table}/${sel.id}`, { method: 'DELETE' });
    await loadTable(def.table);
    buildDatalists();
    state.selection = null;
    renderEditor();
    renderList();
    refreshStatus();
    toast(`Deleted ${def.label} #${sel.id}.`);
  } catch (e) { toast('Delete failed: ' + e.message, true); }
});

async function createRecord(clone) {
  const def = TAB_DEF[state.tab];
  const body = {};
  if (clone) {
    const sel = state.selection;
    if (!sel || sel.type !== def.type) return toast('Select a record to clone first.', true);
    body.cloneFrom = sel.id;
  }
  try {
    const recNew = await api(`/api/table/${def.table}`, { method: 'POST', body });
    if (def.table !== 'Spell') {
      await loadTable(def.table);
      buildDatalists();
    }
    await renderList();
    select(def.type, recNew.ID);
    refreshStatus();
    toast(`Created ${def.label} #${recNew.ID}${clone ? ` (clone of #${body.cloneFrom})` : ''}.`);
  } catch (e) { toast('Create failed: ' + e.message, true); }
}

// tabs & search
document.querySelectorAll('#tabs .tab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#tabs .tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.tab = b.dataset.tab;
    state.search = '';
    $('#search').value = '';
    renderList();
  });
});
let searchTimer = null;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = e.target.value; renderList(); }, 200);
});
$('#btn-more').addEventListener('click', () => renderList(true));

$('#chk-wireframe').addEventListener('change', (e) => Viewer.setWireframe(e.target.checked));
$('#chk-spin').addEventListener('change', (e) => Viewer.setSpin(e.target.checked));
$('#chk-particles').addEventListener('change', (e) => Viewer.setParticles(e.target.checked));
{
  const rng = $('#rng-bright');
  const lbl = $('#lbl-bright');
  const saved = Number(localStorage.getItem('previewBrightness'));
  if (saved >= 0.5 && saved <= 4) rng.value = saved;
  const applyBright = () => {
    Viewer.setBrightness(Number(rng.value));
    lbl.textContent = `${Number(rng.value).toFixed(1)}×`;
    localStorage.setItem('previewBrightness', rng.value);
  };
  applyBright();
  rng.addEventListener('input', applyBright);

  const BG_NAMES = ['dark', 'medium', 'light'];
  const btnBg = $('#btn-bg');
  let bgIdx = Number(localStorage.getItem('previewBg')) || 0;
  if (bgIdx < 0 || bgIdx >= Viewer.backgroundLevels) bgIdx = 0;
  const applyBg = () => {
    Viewer.setBackground(bgIdx);
    btnBg.textContent = `bg: ${BG_NAMES[bgIdx]}`;
    localStorage.setItem('previewBg', bgIdx);
  };
  applyBg();
  btnBg.addEventListener('click', () => {
    bgIdx = (bgIdx + 1) % Viewer.backgroundLevels;
    applyBg();
  });
}

// resizable preview panel
{
  const saved = Number(localStorage.getItem('previewWidth'));
  if (saved >= 280) document.documentElement.style.setProperty('--preview-w', saved + 'px');
  const resizer = $('#preview-resizer');
  let resizing = false;
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizing = true;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const w = Math.min(Math.round(window.innerWidth * 0.7), Math.max(280, window.innerWidth - e.clientX));
    document.documentElement.style.setProperty('--preview-w', w + 'px');
    localStorage.setItem('previewWidth', w);
  });
  window.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    resizer.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ---------- boot ----------

async function boot(isReload) {
  await refreshStatus();
  await Promise.all([
    loadTable('SpellVisual'),
    loadTable('SpellVisualKit'),
    loadTable('SpellVisualEffectName'),
    loadTable('SpellEffectCameraShakes'),
    loadTable('SoundEntries'),
    loadTable('AnimationData'),
    loadTable('SpellCastTimes'),
    loadTable('SpellRange'),
  ]);
  buildDatalists();

  const summary = $('#status-summary');
  summary.textContent = '';
  const t = state.status ? state.status.tables : {};
  const rows = Object.entries(t).map(([name, st]) =>
    el('div', {}, `${st.state === 'ok' ? '✔' : st.state === 'missing' ? '–' : '✖'} ${name}`,
      el('span', { class: 'sub', style: 'color:var(--muted)' },
        st.state === 'ok' ? ` ${st.recordCount} records` : st.error ? ` ${st.error}` : ' not present')));
  summary.append(el('div', { class: 'card', style: 'margin-top:18px' },
    el('h3', {}, 'DBC files'), ...rows));
  const mpqInfo = state.status && state.status.mpq;
  summary.append(el('div', { class: 'card' },
    el('h3', {}, 'Game data (3D previews)'),
    mpqInfo && mpqInfo.archives.length
      ? el('div', {}, `✔ MPQ archives loaded: ${mpqInfo.archives.join(', ')}`)
      : el('div', {}, 'No MPQ archives found. Copy your client’s model.MPQ / patch.MPQ / patch-2.MPQ (or the whole Data folder) into gamedata/ for 3D model previews, then press "Reload from disk".'),
    ...(mpqInfo ? mpqInfo.errors.map((e2) => el('div', { style: 'color:var(--danger)' }, `✖ ${e2.name}: ${e2.error}`)) : [])));
  if (t.Spell && t.Spell.state !== 'ok') {
    summary.prepend(el('div', { class: 'banner' },
      el('b', {}, 'Spell.dbc is truncated or missing. '),
      'The file in /dbc is only a header stub (32 bytes) — a full 1.12.1 Spell.dbc is ~37 MB. ',
      'Re-export it (e.g. from your client MPQs or server data) and click "Reload from disk". ',
      'Visuals, kits and effects are fully editable in the meantime.'));
  }

  if (!isReload) renderList();
  else { renderList(); renderEditor(); }

  // deep link: #files opens the save/export dialog
  if (location.hash === '#files' && !isReload) openFileDialog();
  // deep link: #visual/4, #kit/8, #effect/2, #spell/133, #effect/716/lab, #effect/2/browse, #visual/6824/story
  const m = location.hash.match(/^#(spell|visual|kit|effect)\/(\d+)(\/lab|\/browse|\/story)?$/);
  if (m && !isReload) {
    const tabKey = Object.keys(TAB_DEF).find((k) => TAB_DEF[k].type === m[1]);
    if (tabKey && tabKey !== state.tab) {
      document.querySelectorAll('#tabs .tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tabKey));
      state.tab = tabKey;
      await renderList();
    }
    select(m[1], Number(m[2]));
    if (m[3] === '/story' && m[1] === 'visual') {
      openStoryboard(Number(m[2]), null);
    } else if (m[3] && m[1] === 'effect') {
      const eff = rec('SpellVisualEffectName', Number(m[2]));
      if (eff && m[3] === '/lab') openLab(eff);
      else if (eff && m[3] === '/browse') {
        openModelBrowser((path) => {
          eff.FileName = path;
          scheduleSave('SpellVisualEffectName', eff);
          renderEditor();
        });
      }
    }
  }
}

// surface unexpected JS errors instead of failing silently
window.addEventListener('error', (e) => toast(`JS error: ${e.message}`, true));
window.addEventListener('unhandledrejection', (e) => toast(`Unhandled: ${e.reason && e.reason.message || e.reason}`, true));

boot(false);
