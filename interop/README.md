# Interop with Stoneharry's WoW Spell Editor

Two ways to pair this suite with [Stoneharry's WoW Spell Editor](https://github.com/stoneharry/WoW-Spell-Editor)
(DBC → MySQL → vmangos). Pick based on how tightly you want them coupled.

## 1. Shared MySQL (recommended) — no files, no re-import

Point this suite at the same MySQL database Stoneharry fills, and it becomes the
single source of truth. Set these before `npm start`:

```bash
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_USER=root MYSQL_PASSWORD=... \
MYSQL_DATABASE=your_stoneharry_db npm start
```

(One-time: `npm install mysql2` — it's an optional dependency.)

On boot the suite reads `Spell`, `SpellVisual`, `SpellVisualKit` and
`SpellVisualEffectName` from MySQL instead of `dbc/`. Edits here save straight
back to those tables, so Stoneharry sees them with no export/re-import.

**Why the column mismatch doesn't matter.** Stoneharry's 1.12 `SpellVisual` /
`SpellVisualKit` bindings use the TBC-derived layout (`StateDoneKit`, weapon-effect
slots, 3-wide char params), which is wrong for vanilla — this suite's schemas are
corrected against the real client bytes. But both tables are the same *width*, and
this suite maps **by column ordinal, not by Stoneharry's field names**. Ordinal N =
DBC byte offset N = the correct vanilla field, so the mislabeling is invisible and
the data round-trips byte-for-byte.

The suite also reconciles per-column types automatically (e.g. `Speed`, which
Stoneharry stores as an integer bit-pattern, is read back as a float).

## 2. Corrected binding files — if you also want to *view* these tables in Stoneharry

`Bindings_112_vanilla/` contains drop-in replacements for Stoneharry's
`SpellVisual.txt`, `SpellVisualKit.txt` and `SpellVisualEffectName.txt`, using the
correct vanilla layout. Copy them into Stoneharry's `Documentation/Bindings_112_vanilla/`
folder and re-import those DBCs there, and Stoneharry will label the columns the way
the real client reads them.

Safe to do: these three tables are client-only (vmangos never reads them), so
changing their MySQL column names breaks nothing downstream. Only needed if you edit
visuals inside Stoneharry's own UI — with the shared-MySQL workflow above you don't,
so this is optional.

> Do **not** edit `SpellVisual`/`SpellVisualKit` in Stoneharry with its *stock*
> bindings and export to your client — the TBC-shifted layout misrenders those tables
> in 1.12. Either use these corrected bindings, or leave visual editing to this suite.

## Division of labour

- **Stoneharry** owns `Spell.dbc` + server-side (→ MySQL → vmangos). `Spell.dbc` is
  already byte-compatible between the two tools.
- **This suite** owns the three visual tables (→ client patch MPQ).
- They coordinate through `Spell.SpellVisual1`/`SpellVisual2` (plain integer IDs,
  read identically by both).
