# Spell Visual Editor — WoW 1.12.1

A local web editor for vanilla (1.12.1 / build 5875) spell visuals, working **directly on
DBC files** — no database, no dependencies.

## Run

```
npm start          # or: node server/index.js
```

Then open **http://localhost:3414** (set `PORT` to change).

## What it does

- Parses/writes the WDBC files in [dbc/](dbc/) with correct 1.12.1 layouts.
- Browse & edit the full spell visual chain:
  - **Spell** → `SpellVisualID[2]`
  - **SpellVisual** → precast / cast / impact / state / channel / area kits + missile
  - **SpellVisualKit** → animation, sound, camera shake, attached effects, character procs
  - **SpellVisualEffectName** → model name / file path / scale
- Create, clone, and delete records; jump between references; see reverse usage.
- **Deep-clone a whole visual chain** in one click (spell → visual → kits → effects, all
  references rewired to the new copies) — no manual multi-table editing.
- 3D preview of effect models (see *Game data* below), with a **model browser**
  (effect editor → "browse…") to search every model in your archives, preview each in 3D,
  and pick one — instead of typing a raw path.
- **Spell storyboard** (▶ button on spells and visuals): plays the whole sequence on a
  caster/target mannequin pair — precast kit while casting → cast kit + anim → missile
  flight at the spell's real speed with particle trails → impact kit on the target →
  looping state aura — with kit sounds and animations firing at each phase. Loops until
  you navigate away.
- **Animation playback**: full vanilla M2 skeletal animation (bone tracks, CPU skinning,
  billboard bones) — spell models auto-play their effect loop, and the preview footer has
  an animation selector (mannequins play Stand by default in the attachment lab).
- **Reference data from your archives**: AnimationData and SoundEntries load straight out
  of the client MPQs, so animations and sounds show real names — and every sound field has
  a ▶ button to audition it.
- **Attachment lab** (effect editor → "Position on character…"): preview any effect model
  attached to a race/gender mannequin at a real attachment point, drag it into place
  (axis-gizmo arrows, shift+drag, or XYZ/yaw/pitch/roll/scale fields), then **bake** the
  transform into a copy of the M2. 1.12 has no offset fields in DBC — position lives in the
  model file (that's how the WSG flag sits on the back while being a ChestEffect) — so the
  baked model is the 1.12-correct way to reposition a visual.

## Saving, exporting, importing

Nothing touches disk until you ask. Edits live in server memory; the **Save / Export…**
dialog (top bar) is the single place for all file operations:

- **Save to project** — overwrite the `.dbc` files in [dbc/](dbc/); originals are copied to
  `dbc/backup/<timestamp>/` first. Confirms before overwriting.
- **Download DBC files** — each table (reflecting your current edits) as a `.dbc`, or a ZIP
  of just the modified ones laid out under `DBFilesClient/`. Never writes to disk.
- **Custom game files** — every baked model listed with its correct in-game path; download
  individually or as a ZIP with folder structure preserved (drag straight into Ladik's MPQ
  Editor).
- **Client patch MPQ** — one `patch-3.MPQ` with your custom models, optionally including the
  modified DBCs under `DBFilesClient\`.
- **Import DBC** — replace a project DBC with one edited elsewhere; validated against the
  1.12.1 layout before anything is overwritten, old file backed up.

## Data notes

- `Spell.dbc` shipped in this repo is a truncated stub (32 bytes — the header claims
  ~37 MB / 49,841 records). Replace it with a full 1.12.1 export and press
  **Reload from disk** to enable the spell browser. Everything else works without it.
- `SpellAuraNames.dbc` and `SpellEffectNames.dbc` are 0 bytes (also corrupt, but they are
  only label tables — not needed for visuals).
- Optional: drop `SoundEntries.dbc` and/or `AnimationData.dbc` into `dbc/` to get sound
  and animation names instead of raw IDs.

## Game data (3D previews)

The DBCs only reference model *paths* (e.g. `Spells\FireBolt_ImpactDD_Med_Chest.mdx`).
To see the actual models, **copy your 1.12.1 client MPQs into `gamedata/`** — no extraction
needed (reading uses StormLib compiled to WASM, `npm install` pulls it in):

```
gamedata/
  model.MPQ        # spell/creature models
  patch.MPQ        # patches override base archives
  patch-2.MPQ
```

Copying (or pointing `GAMEDATA_DIR` at) the client's whole `Data` folder also works —
`.MPQ` files are discovered in `gamedata/` and `gamedata/Data/`. Priority: `patch-2` >
`patch` > everything else. Loose extracted files under `gamedata/` (e.g.
`gamedata/Spells/Foo.m2`) override archives. `.mdx`/`.mdl` references resolve to `.m2`
automatically. Models render with BLP textures, correct blend modes, and a real-time
particle-emitter simulation (approximate: bind pose, static emitters, heads-only —
no texture animation or spline emitters). Orbit with mouse drag, zoom with wheel.
After adding archives, press **Reload from disk** in the UI (or restart).

## 1.12.1 layout corrections

The schemas in [server/schemas.js](server/schemas.js) mostly follow WDBX Editor's
"Classic 1.12.1 (5875)" definitions, but two tables were corrected against the actual
binary data (WDBX reuses the TBC layouts, which are wrong for vanilla):

- **SpellVisual** (16 cols): no `StateDoneKit`; vanilla has
  `HasAreaEffect`, `AreaModel`, `AreaKit`, `AnimEventSoundID` after `MissileSound`.
- **SpellVisualKit** (35 cols): `KitType` instead of `StartAnimID`/`AnimKitID`, no
  left/right weapon effect slots, and **four** char param float rows
  (`CharParamZero..Three[4]`) after `CharProc[4]`.

Verified empirically: `HasMissile` is strictly 0/1, `ShakeID` ≤ 66 (max camera shake ID),
model references stay within `SpellVisualEffectName` ID range, and proc rows decode to
coherent (color, scale, …) float params. All tables round-trip byte-for-byte.
