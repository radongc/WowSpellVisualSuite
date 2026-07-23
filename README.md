# WoW 1.12.1 Spell Visual Suite

A local, browser-based editor for **World of Warcraft 1.12.1 (build 5875)** spell visuals.

See [Game data](#game-data).

<img width="2055" height="1225" alt="brave_1FJ2yElhjo" src="https://github.com/user-attachments/assets/bda5b4e4-1ce0-443b-ae3a-0c88d2562e8e" />

## Features

- **Full visual-chain editing** — Spell → SpellVisual (precast / cast / impact / state /
  channel / area kits + missile) → SpellVisualKit → SpellVisualEffectName, with cross-links,
  breadcrumbs, and reverse-usage ("which spells use this?").
- **Create / clone / delete** any record, plus **one-click deep-clone** of a whole visual
  chain so you can customize a spell without touching the original.
- **3D preview** of every effect model, with a searchable **model browser** and real vanilla
  **skeletal animation** playback (CPU skinning, billboards, per-sequence scrubbing).
- **Spell storyboard** — plays the full sequence on caster/target actors: precast → cast →
  missile flight at the spell's real speed → impact → looping state aura, with kit sounds.
- **Attachment lab** — preview an effect at a real attachment point, place it with
  drag / gizmo / numeric transform, then **bake** the offset into a copy of the M2.
- **Reference data** — AnimationData and SoundEntries load from your archives, so animations
  and sounds show real names, with a ▶ play button on every sound.
- **Spell icons**, **undo / redo** (Ctrl+Z / Ctrl+Y), and a **Save / Export / Import** dialog.

## Setup

Requires **Node.js 18+**.

```bash
git clone https://github.com/radongc/WowSpellVisualSuite.git
cd WowSpellVisualSuite
npm install
npm start
```

Open **http://localhost:3414** (set `PORT` to change). Give it your game data first (see below).

## Game data

Point the suite at your own 1.12.1 client (either or both):

- **Client archives (recommended)** — copy your `Data` folder's `.MPQ` files into a
  `gamedata/` folder at the repo root (or the whole `Data` folder). This provides the
  models/textures/sounds **and** auto-loads the spell DBCs, so you may not need `dbc/` at all.
- **Loose DBCs** — drop 1.12.1 `.dbc` exports into a `dbc/` folder. Tables in `dbc/` take
  priority over the archive copies; saves land here.

MPQ reading uses [StormLib compiled to WASM](https://github.com/wowserhq/stormjs) — no
extraction needed. Archives are discovered in `gamedata/` and `gamedata/Data/`, in client
load order (`patch-<letter>` > `patch-<number>` > `patch` > base). Loose files under
`gamedata/` override archive copies; `.mdx`/`.mdl` references resolve to `.m2` automatically.
`gamedata/` and `dbc/` are gitignored.

## Saving, exporting, importing

Nothing is written to disk until you ask. Edits live in server memory; the **Save /
Export…** dialog is the single place for all file operations:

- **Save to project** — overwrite `dbc/`, backing up originals to `dbc/backup/<timestamp>/`.
- **Download DBC files** — any table (with current edits) as a `.dbc`, or a ZIP under
  `DBFilesClient/`.
- **Custom game files** — every baked model with its correct in-game path, individually or
  as a structure-preserving ZIP.
- **Client patch MPQ** — one ready-to-ship `patch-3.MPQ`, optionally bundling the DBCs.
- **Import DBC** — replace a project DBC with one edited elsewhere, validated against the
  1.12.1 layout first.

## Project layout

```
server/     zero-framework Node HTTP server + DBC / M2 / BLP / MPQ / PNG / ZIP codecs
public/     single-page frontend (vanilla JS + a hand-rolled WebGL viewer, no build)
dbc/        your 1.12.1 DBC files (gitignored)
gamedata/   your client MPQs / extracted files (gitignored)
```

The only runtime dependency is StormJS for reading MPQs; the DBC, M2, BLP, PNG and ZIP
handling is all in-repo.

## Credits

- Model, texture and archive formats: the [wowdev.wiki](https://wowdev.wiki) community.
- 1.12.1 DBC field definitions: [WDBXEditor](https://github.com/WowDevTools/WDBXEditor)
  (corrected where noted above).
- MPQ reading: [StormJS](https://github.com/wowserhq/stormjs) / StormLib.

## License

[MIT](LICENSE) © radongc
