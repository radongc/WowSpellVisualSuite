# WoW 1.12.1 Spell Visual Suite

A local, browser-based editor for **World of Warcraft 1.12.1 (build 5875)** spell visuals.
It works directly on the game's DBC files — no database, no build step — and renders the
actual game models (M2), textures (BLP), particles and skeletal animation straight out of
your client's MPQ archives so you can *see* a spell before you ship it.

> **You supply the game data.** This project ships no Blizzard files. Point it at your own
> 1.12.1 client and it reads everything it needs. See [Game data](#game-data).

---

## Features

- **Full visual-chain editing** — Spell → `SpellVisualID` → SpellVisual (precast / cast /
  impact / state / channel / area kits + missile) → SpellVisualKit (animation, sound,
  camera shake, attached effect slots, character procs) → SpellVisualEffectName (model,
  scale). Cross-links, breadcrumbs, and reverse-usage ("which spells use this?").
- **Create / clone / delete** any record, plus **one-click deep-clone** of a whole visual
  chain (visual + kits + effects, all references rewired to fresh copies) so you can
  customize a spell without touching the original.
- **3D preview** of every effect model with a searchable **model browser** — pick a model
  from your archives visually instead of typing a path.
- **Skeletal animation playback** — real vanilla M2 bone animation with CPU skinning and
  billboards; models auto-play their loop and an animation selector lets you scrub sequences
  by name.
- **Spell storyboard** — plays the entire sequence on textured caster/target actors:
  precast → cast (with animation) → missile flight at the spell's real speed & range →
  impact → looping state aura, with kit sounds and animations firing per phase.
- **Attachment lab** — preview an effect on a character at a real attachment point, place it
  with drag / axis-gizmo / numeric XYZ-rotation-scale, then **bake** the transform into a
  copy of the M2. (1.12 has no positional fields in DBC — the offset lives in the model, the
  same trick the Warsong flag uses to sit on a player's back while being a chest effect.)
- **Reference data & audition** — AnimationData and SoundEntries load from your archives, so
  animations and sounds show real names, and every sound field has a ▶ play button.
- **Spell icons** shown in the browser and editor.
- **Undo / redo** for every record edit (Ctrl+Z / Ctrl+Y), and a **Save / Export / Import**
  dialog that keeps all file operations in one place with confirmations.

---

## Requirements

- **Node.js 18+**
- A **World of Warcraft 1.12.1 (5875)** client, for the game data (models, textures, sounds,
  and — optionally — the DBCs). Nothing here is downloaded for you.

## Setup

```bash
git clone https://github.com/radongc/WowSpellVisualSuite.git
cd WowSpellVisualSuite
npm install
```

Give it your game data (either or both):

- **Client archives (recommended)** — copy your 1.12.1 `Data` folder's `.MPQ` files into a
  `gamedata/` folder at the repo root (or copy the whole `Data` folder in). This provides
  the models/textures/sounds **and** auto-loads the spell DBCs from the archives, so you may
  not need to touch `dbc/` at all.
- **Loose DBCs** — drop 1.12.1 `.dbc` exports into a `dbc/` folder to edit those directly.
  Tables found in `dbc/` take priority over the archive copies; saves land here.

Then:

```bash
npm start          # or: node server/index.js
```

Open **http://localhost:3414** (set `PORT` to change; set `GAMEDATA_DIR` to point the model
loader elsewhere). `gamedata/` and `dbc/` are gitignored — your game files never enter the
repo.

## Saving, exporting, importing

Nothing is written to disk until you ask. Edits live in server memory; the **Save /
Export…** dialog (top bar) is the single place for all file operations:

- **Save to project** — overwrite the `.dbc` files in `dbc/`; originals are copied to
  `dbc/backup/<timestamp>/` first. Confirms before overwriting.
- **Download DBC files** — each table (reflecting current edits) as a `.dbc`, or a ZIP of the
  modified ones laid out under `DBFilesClient/`. Never writes to disk.
- **Custom game files** — every baked model listed with its correct in-game path; download
  individually or as a structure-preserving ZIP (drag straight into an MPQ editor).
- **Client patch MPQ** — one ready-to-ship `patch-3.MPQ` with your custom models, optionally
  bundling the modified DBCs under `DBFilesClient\`.
- **Import DBC** — replace a project DBC with one edited elsewhere; validated against the
  1.12.1 layout before anything is overwritten, old file backed up.

Editing is client-side (SpellVisual data is not read by the server), so exported DBCs go into
your client's patch MPQ; `Spell.dbc` goes to both client and server as usual.

## Game data

The DBCs only reference model *paths* (e.g. `Spells\FireBolt_ImpactDD_Med_Chest.mdx`); the
suite resolves them out of your archives. Reading uses **StormLib compiled to WASM**
([@wowserhq/stormjs](https://github.com/wowserhq/stormjs), the only runtime dependency —
`npm install` pulls it in), so **no extraction is needed** — just copy the `.MPQ` files in.

```
gamedata/
  model.MPQ        # spell/creature models
  texture.MPQ      # textures
  sound.MPQ        # sounds (for the ▶ audition buttons)
  patch.MPQ        # patches override base archives
  patch-2.MPQ
  ...
```

- Archives are discovered in `gamedata/` and `gamedata/Data/`. Load priority mirrors the
  client: `patch-<letter>` > `patch-<number>` > `patch` > base.
- **Loose files** under `gamedata/` (e.g. `gamedata/Spells/Foo.m2`) override archive copies —
  this is where the attachment lab's baked models land.
- `.mdx`/`.mdl` references resolve to `.m2` automatically; lookups are case-insensitive.

**Rendering fidelity.** Models render with BLP textures, correct blend modes, skeletal
animation, and a real-time particle simulation. It's a faithful preview, not the game
engine — approximations include linear (not spline) track interpolation, head-only particles
without texture-scroll animation, and creature skins resolved by convention rather than via
CreatureDisplayInfo. Player-character models render untextured (their skins are composited
from CharSections); creature-humanoid models render fully textured.

## 1.12.1 layout corrections

The schemas in [server/schemas.js](server/schemas.js) mostly follow WDBX Editor's
"Classic 1.12.1 (5875)" definitions, but two tables were corrected against the actual binary
data (WDBX reuses the TBC layouts, which are wrong for vanilla):

- **SpellVisual** (16 cols): no `StateDoneKit`; vanilla has `HasAreaEffect`, `AreaModel`,
  `AreaKit`, `AnimEventSoundID` after `MissileSound`.
- **SpellVisualKit** (35 cols): `KitType` instead of `StartAnimID`/`AnimKitID`, no left/right
  weapon-effect slots, and **four** char-param float rows (`CharParamZero..Three[4]`) after
  `CharProc[4]`.

Verified empirically: `HasMissile` is strictly 0/1, `ShakeID` ≤ 66 (max camera-shake ID),
model references stay within `SpellVisualEffectName` ID range, and proc rows decode to
coherent float params. All tables round-trip byte-for-byte.

## Project layout

```
server/     zero-framework Node HTTP server + DBC / M2 / BLP / MPQ / PNG / ZIP codecs
public/     single-page frontend (vanilla JS + a hand-rolled WebGL viewer, no build)
dbc/        your 1.12.1 DBC files (gitignored)
gamedata/   your client MPQs / extracted files (gitignored)
```

Everything is dependency-light on purpose: the only runtime package is StormJS for reading
MPQs; the DBC, M2, BLP, PNG and ZIP handling is all in-repo.

## Credits

- Model, texture and archive formats: the [wowdev.wiki](https://wowdev.wiki) community.
- 1.12.1 DBC field definitions: [WDBXEditor](https://github.com/WowDevTools/WDBXEditor)
  (corrected where noted above).
- MPQ reading: [StormJS](https://github.com/wowserhq/stormjs) / StormLib.

## Legal

World of Warcraft and all related assets are trademarks and © of Blizzard Entertainment.
This is an unofficial, fan-made tool **not affiliated with or endorsed by Blizzard**. It
distributes no game data — you supply your own client files, which the tool reads locally and
never redistributes. Intended for private-server development, modding, and educational use.

## License

[MIT](LICENSE) © radongc
