# WoW 1.12.1 Spell Visual Suite

A local, browser-based editor for **World of Warcraft 1.12.1 (build 5875)** spell visuals.
It works directly on the game's DBC files — no database, no build step — and renders the
actual game models (M2), textures (BLP), particles and skeletal animation straight out of
your client's MPQ archives, so you can *see* a spell before you ship it.

You supply your own 1.12.1 client; the tool reads it locally. See [Game data](#game-data).

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
- **Client patch MPQ** — one ready-to-ship archive (named the next winning patch letter),
  optionally bundling the DBCs. Set `CLIENT_DIR` to your WoW `Data` folder to also get a
  one-click **Deploy to client** button that writes it straight there.
- **Import DBC** — replace a project DBC with one edited elsewhere, validated against the
  1.12.1 layout first.

## Pairing with Stoneharry's Spell Editor (vmangos)

If you drive server-side spell data through [Stoneharry's WoW Spell Editor](https://github.com/stoneharry/WoW-Spell-Editor)
(DBC → MySQL → vmangos), point this suite at the **same MySQL database** so there's no
DBC-file round-trip and no drop-and-reimport to resync.

Open **⚙ Settings** in the top bar, enter your MySQL connection (the same database Stoneharry
fills — e.g. `spelledit`) and, optionally, your WoW client's `Data` folder, then **Test
connection** and **Save**. That's it — settings persist to a gitignored `config.json`, so your
password never enters the repo and you only do this once. (First time only: `npm install mysql2`.)

The suite then reads `Spell`, `SpellVisual`, `SpellVisualKit` and `SpellVisualEffectName`
from MySQL and saves edits straight back — Stoneharry sees them immediately. It maps columns
**by ordinal**, so Stoneharry's TBC-style (mislabeled) visual columns are handled correctly
without any binding changes. Setting the client Data folder also adds a one-click **Deploy to
client** button to the Save / Export dialog.

Full details, the optional corrected binding files, and a live smoke test
(`node interop/mysql-smoketest.js`) are in [interop/](interop/README.md).
Prefer env vars or a config file? `config.json` (copy `config.example.json`) and the
`MYSQL_*` / `CLIENT_DIR` environment variables both work too.

## 1.12.1 layout corrections

The schemas in [server/schemas.js](server/schemas.js) mostly follow WDBX Editor's
"Classic 1.12.1 (5875)" definitions, but two tables were corrected against the actual binary
data (WDBX reuses the TBC layouts, which are wrong for vanilla):

- **SpellVisual** (16 cols): no `StateDoneKit`; vanilla has `HasAreaEffect`, `AreaModel`,
  `AreaKit`, `AnimEventSoundID` after `MissileSound`.
- **SpellVisualKit** (35 cols): `KitType` instead of `StartAnimID`/`AnimKitID`, no left/right
  weapon-effect slots, and **four** char-param float rows after `CharProc[4]`.

All tables round-trip byte-for-byte.

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
