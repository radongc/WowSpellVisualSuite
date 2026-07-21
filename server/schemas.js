// 1.12.1 (build 5875) DBC schemas.
// Field types: 'int' (int32), 'uint' (uint32), 'float', 'string' (string-block offset),
// 'loc' (localized string: 8 lang strings + flags bitmask = 9 columns).
// Sources: WDBXEditor "Classic 1.12.1 (5875)" definitions, cross-checked and corrected
// against the actual binary data in /dbc (SpellVisual and SpellVisualKit differ from
// WDBX, which reused the TBC layout; the vanilla client structs match the Alpha
// layouts plus vanilla additions — verified empirically column-by-column).

function f(name, type, arraySize) {
  return arraySize ? { name, type, arraySize } : { name, type };
}

const SCHEMAS = {
  Spell: [
    f('ID', 'int'),
    f('School', 'int'),
    f('Category', 'int', ),
    f('CastUI', 'int'),
    f('DispelType', 'int'),
    f('Mechanic', 'int'),
    f('Attributes', 'uint'),
    f('AttributesEx', 'uint'),
    f('AttributesEx2', 'uint'),
    f('AttributesEx3', 'uint'),
    f('AttributesEx4', 'uint'),
    f('ShapeshiftMask', 'uint'),
    f('ShapeshiftExclude', 'uint'),
    f('Targets', 'uint'),
    f('TargetCreatureType', 'uint'),
    f('RequiresSpellFocus', 'int'),
    f('CasterAuraState', 'int'),
    f('TargetAuraState', 'int'),
    f('CastingTimeIndex', 'int'),
    f('RecoveryTime', 'int'),
    f('CategoryRecoveryTime', 'int'),
    f('InterruptFlags', 'uint'),
    f('AuraInterruptFlags', 'uint'),
    f('ChannelInterruptFlags', 'uint'),
    f('ProcTypeMask', 'uint'),
    f('ProcChance', 'int'),
    f('ProcCharges', 'int'),
    f('MaxLevel', 'int'),
    f('BaseLevel', 'int'),
    f('SpellLevel', 'int'),
    f('DurationIndex', 'int'),
    f('PowerType', 'int'),
    f('ManaCost', 'int'),
    f('ManaCostPerLevel', 'int'),
    f('ManaCostPerSecond', 'int'),
    f('ManaCostPerSecondPerLevel', 'int'),
    f('RangeIndex', 'int'),
    f('Speed', 'float'),
    f('ModalNextSpell', 'int'),
    f('StackAmount', 'int'),
    f('Totem', 'int', 2),
    f('Reagent', 'int', 8),
    f('ReagentCount', 'int', 8),
    f('EquippedItemClass', 'int'),
    f('EquippedItemSubclass', 'int'),
    f('EquippedItemInvType', 'int'),
    f('Effect', 'int', 3),
    f('EffectDieSides', 'int', 3),
    f('EffectBaseDice', 'int', 3),
    f('EffectDicePerLevel', 'float', 3),
    f('EffectRealPointsPerLevel', 'float', 3),
    f('EffectBasePoints', 'int', 3),
    f('EffectMechanic', 'int', 3),
    f('ImplicitTargetA', 'int', 3),
    f('ImplicitTargetB', 'int', 3),
    f('EffectRadiusIndex', 'int', 3),
    f('EffectAura', 'int', 3),
    f('EffectAmplitude', 'int', 3),
    f('EffectMultipleValue', 'float', 3),
    f('EffectChainTarget', 'int', 3),
    f('EffectItemType', 'int', 3),
    f('EffectMiscValue', 'int', 3),
    f('EffectTriggerSpell', 'int', 3),
    f('EffectPointsPerCombo', 'float', 3),
    f('SpellVisualID', 'int', 2),
    f('SpellIconID', 'int'),
    f('ActiveIconID', 'int'),
    f('SpellPriority', 'int'),
    f('Name', 'loc'),
    f('NameSubtext', 'loc'),
    f('Description', 'loc'),
    f('AuraDescription', 'loc'),
    f('ManaCostPct', 'int'),
    f('StartRecoveryCategory', 'int'),
    f('StartRecoveryTime', 'int'),
    f('MaxTargetLevel', 'int'),
    f('SpellClassSet', 'int'),
    f('SpellClassMask', 'uint', 2),
    f('MaxTargets', 'int'),
    f('DefenseType', 'int'),
    f('PreventionType', 'int'),
    f('StanceBarOrder', 'int'),
    f('DamageMultiplier', 'float', 3),
    f('MinFactionId', 'int'),
    f('MinReputation', 'int'),
    f('RequiredAuraVision', 'int'),
  ],

  // Vanilla layout (differs from WDBX/TBC): no StateDoneKit; has area-effect block.
  // Verified: HasMissile is strictly 0/1 at col 6, MissileModel <= max effect ID at
  // col 7, path type 0-2 at col 8, HasAreaEffect 0/1 at col 11, AreaModel/AreaKit
  // refs at 12/13, AnimEventSoundID uses -1 sentinel at col 14.
  SpellVisual: [
    f('ID', 'int'),
    f('PrecastKit', 'int'),
    f('CastKit', 'int'),
    f('ImpactKit', 'int'),
    f('StateKit', 'int'),
    f('ChannelKit', 'int'),
    f('HasMissile', 'int'),
    f('MissileModel', 'int'),
    f('MissilePathType', 'int'),
    f('MissileDestinationAttachment', 'int'),
    f('MissileSound', 'int'),
    f('HasAreaEffect', 'int'),
    f('AreaModel', 'int'),
    f('AreaKit', 'int'),
    f('AnimEventSoundID', 'int'),
    f('MissileAttachment', 'int'),
  ],

  // Vanilla layout (differs from WDBX/TBC): KitType instead of StartAnimID/AnimKitID,
  // no weapon-effect slots, and a fourth char-param row. Verified: SoundID values at
  // col 13, ShakeID <= 66 (max camera-shake ID) at col 14, CharProc rows use -1
  // sentinel at cols 15-18, float params (colors/scales) grouped at 19-22/23-26/
  // 27-30/31-34.
  SpellVisualKit: [
    f('ID', 'int'),
    f('KitType', 'int'),
    f('AnimID', 'int'),
    f('HeadEffect', 'int'),
    f('ChestEffect', 'int'),
    f('BaseEffect', 'int'),
    f('LeftHandEffect', 'int'),
    f('RightHandEffect', 'int'),
    f('BreathEffect', 'int'),
    f('SpecialEffect', 'int', 3),
    f('WorldEffect', 'int'),
    f('SoundID', 'int'),
    f('ShakeID', 'int'),
    f('CharProc', 'int', 4),
    f('CharParamZero', 'float', 4),
    f('CharParamOne', 'float', 4),
    f('CharParamTwo', 'float', 4),
    f('CharParamThree', 'float', 4),
  ],

  SpellVisualEffectName: [
    f('ID', 'int'),
    f('Name', 'string'),
    f('FileName', 'string'),
    f('AreaEffectSize', 'int'),
    f('Scale', 'float'),
  ],

  SpellVisualPrecastTransitions: [
    f('ID', 'int'),
    f('LoadAnimation', 'string'),
    f('HoldAnimation', 'string'),
  ],

  SpellEffectCameraShakes: [
    f('ID', 'int'),
    f('CameraShake', 'int', 3),
  ],

  SpellChainEffects: [
    f('ID', 'int'),
    f('AvgSegLen', 'float'),
    f('Width', 'float'),
    f('NoiseScale', 'float'),
    f('TexCoordScale', 'float'),
    f('SegDuration', 'int'),
    f('SegDelay', 'int'),
    f('Texture', 'string'),
  ],

  SpellCastTimes: [
    f('ID', 'int'),
    f('Base', 'int'),
    f('PerLevel', 'int'),
    f('Minimum', 'int'),
  ],

  SpellCategory: [
    f('ID', 'int'),
    f('Flags', 'int'),
  ],

  SpellDispelType: [
    f('ID', 'int'),
    f('Name', 'loc'),
    f('Mask', 'int'),
    f('ImmunityPossible', 'int'),
  ],

  SpellDuration: [
    f('ID', 'int'),
    f('Duration', 'int'),
    f('DurationPerLevel', 'int'),
    f('MaxDuration', 'int'),
  ],

  SpellFocusObject: [
    f('ID', 'int'),
    f('Name', 'loc'),
  ],

  SpellIcon: [
    f('ID', 'int'),
    f('TextureFilename', 'string'),
  ],

  SpellItemEnchantment: [
    f('ID', 'int'),
    f('EnchantmentType', 'int', 3),
    f('EffectPointsMin', 'int', 3),
    f('EffectPointsMax', 'int', 3),
    f('EffectArg', 'int', 3),
    f('Name', 'loc'),
    f('ItemVisual', 'int'),
    f('Flags', 'int'),
  ],

  SpellMechanic: [
    f('ID', 'int'),
    f('StateName', 'loc'),
  ],

  SpellRadius: [
    f('ID', 'int'),
    f('Radius', 'float'),
    f('RadiusPerLevel', 'float'),
    f('RadiusMax', 'float'),
  ],

  SpellRange: [
    f('ID', 'int'),
    f('RangeMin', 'float'),
    f('RangeMax', 'float'),
    f('Flags', 'int'),
    f('DisplayName', 'loc'),
    f('DisplayNameShort', 'loc'),
  ],

  SpellShapeshiftForm: [
    f('ID', 'int'),
    f('BonusActionBar', 'int'),
    f('Name', 'loc'),
    f('Flags', 'int'),
    f('CreatureType', 'int'),
    f('CombatRoundTime', 'int'),
  ],

  // SpellAuraNames / SpellEffectNames: the provided files are empty (0 bytes).
  // Schemas included so valid files light up if dropped in.
  SpellAuraNames: [
    f('ID', 'int'),
    f('Unused', 'int'),
    f('Name', 'loc'),
  ],

  SpellEffectNames: [
    f('ID', 'int'),
    f('Name', 'loc'),
  ],

  // Optional tables — not shipped in /dbc, but loaded if the user adds them,
  // enabling name lookups for sounds and animations.
  AnimationData: [
    f('ID', 'int'),
    f('Name', 'string'),
    f('WeaponFlags', 'int'),
    f('BodyFlags', 'int'),
    f('Flags', 'int'),
    f('Fallback', 'int'),
    f('BehaviourID', 'int'),
  ],

  SoundEntries: [
    f('ID', 'int'),
    f('SoundType', 'int'),
    f('Name', 'string'),
    f('File', 'string', 10),
    f('Freq', 'int', 10),
    f('DirectoryBase', 'string'),
    f('VolumeFloat', 'float'),
    f('Flags', 'int'),
    f('MinDistance', 'float'),
    f('DistanceCutoff', 'float'),
    f('EAXDef', 'int'),
  ],
};

// number of int32 columns a field occupies
function fieldColumns(field) {
  const per = field.type === 'loc' ? 9 : 1;
  return per * (field.arraySize || 1);
}

function schemaColumns(schema) {
  return schema.reduce((n, fld) => n + fieldColumns(fld), 0);
}

module.exports = { SCHEMAS, fieldColumns, schemaColumns };
