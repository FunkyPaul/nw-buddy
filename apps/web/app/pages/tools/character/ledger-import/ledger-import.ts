import { EQUIP_SLOTS, EquipSlotId, NW_MAX_WEAPON_LEVEL } from '@nw-data/common'
import { MasterItemDefinitions } from '@nw-data/generated'
import { CharacterRecord, GearsetRecord } from '~/data'
import { NW_TRADESKILLS_INFOS } from '~/nw/tradeskill'
import { NW_WEAPON_TYPES } from '~/nw/weapon-types'
import { LedgerCharacterData, LedgerItemRecord, extractLedgerCharacter } from './ledger-character'
import { LedgerFormatError, isLedger, nwCrc32 } from './ledger-parser'

export interface LedgerImportSource {
  categoricalProgressionIds: string[]
  territories: Array<{ id: string | number; label: string }>
  /**
   * The MasterItemDefinitions tables with their uri. Used to resolve the item index of equipped items.
   * Must match the game version the capture was recorded with.
   */
  itemTables?: Array<{ uri: string; rows: MasterItemDefinitions[] }>
  /** weapon abilities, used to resolve skill tree selections */
  abilities?: Array<{ AbilityID: string; WeaponTag?: string; TreeId?: number }>
}

export interface LedgerSkillTreeRow {
  /** weapon tag as used by NW Buddy skill trees */
  weapon: string
  label: string
  tree1: string[]
  tree2: string[]
}

export interface LedgerEquipmentRow {
  slot: EquipSlotId
  itemId: string
  name: string
  gearScore: number
  /** weapon tag of the item, if it is a weapon */
  weaponTag?: string
}

/**
 * The game addresses item definitions by their position in a registry built from the MasterItemDefinitions tables
 * (top level tables, ordered by file name). Measured against a live capture (game data of 2026-10):
 *
 *   registry index = 18231 + row index in the concatenated tables       (up to and including `master_loot`)
 *   registry index = 18231 + 471 + row index                            (tables after `master_loot`)
 *
 * The extra 471 entries after `master_loot` are not part of the exported tables.
 */
const ITEM_REGISTRY_BASE = 18231
const ITEM_REGISTRY_GAP_AFTER = 'javelindata_itemdefinitions_master_loot.json'
const ITEM_REGISTRY_GAP = 471

export interface LedgerImportRow {
  id: string
  label: string
  value: number
}

export interface LedgerImportResult {
  fileName: string
  data: LedgerCharacterData
  name?: string
  level?: number
  faction?: CharacterRecord['faction']
  weapons: LedgerImportRow[]
  tradeskills: LedgerImportRow[]
  territories: LedgerImportRow[]
  equipment: LedgerEquipmentRow[]
  skillTrees: LedgerSkillTreeRow[]
  /** why equipment could not be resolved */
  equipmentWarning?: string
}

/**
 * Weapon item class to the weapon tag NW Buddy uses for skill trees
 */
const ITEM_CLASS_TO_WEAPON_TAG: Record<string, string> = {
  Sword: 'Sword',
  Rapier: 'Rapier',
  Hatchet: 'Axe',
  Flail: 'Flail',
  Spear: 'Spear',
  '2HAxe': 'GreatAxe',
  '2HHammer': 'Warhammer',
  GreatSword: 'Greatsword',
  Musket: 'Rifle',
  Bow: 'Bow',
  Blunderbuss: 'Blunderbuss',
  FireStaff: 'Fire',
  LifeStaff: 'Heal',
  IceMagic: 'Ice',
  VoidGauntlet: 'VoidGauntlet',
  Dagger: 'Dagger',
}

const FACTIONS: Array<{ id: string; value: CharacterRecord['faction'] }> = [
  { id: 'Covenant', value: 'covenant' },
  { id: 'Syndicate', value: 'syndicate' },
  { id: 'Marauder', value: 'marauder' },
]

/**
 * Reads a `ledger.bin` (or a capture zip that contains one) and maps the character data to NW Buddy values.
 */
export async function readLedgerImport(file: File, source: LedgerImportSource): Promise<LedgerImportResult> {
  const bytes = await readLedgerBytes(file)

  const known = new Map<number, string>()
  const addKnown = (id: string | number) => {
    if (id != null && id !== '') {
      known.set(nwCrc32(String(id)), String(id))
    }
  }
  source.categoricalProgressionIds.forEach(addKnown)
  source.territories.forEach((it) => addKnown(it.id))
  NW_WEAPON_TYPES.forEach((it) => addKnown(it.ProgressionId))
  NW_TRADESKILLS_INFOS.forEach((it) => addKnown(it.ID))
  FACTIONS.forEach((it) => addKnown(it.id))

  const data = extractLedgerCharacter(bytes, (crc) => known.get(crc))
  const byCrc = new Map(data.progression.map((it) => [it.crc, it]))
  const lookup = (id: string | number) => byCrc.get(nwCrc32(String(id)))

  const weapons: LedgerImportRow[] = []
  for (const weapon of NW_WEAPON_TYPES) {
    const entry = lookup(weapon.ProgressionId)
    if (!weapons.some((it) => it.id === weapon.ProgressionId)) {
      weapons.push({
        id: weapon.ProgressionId,
        label: weapon.UIName,
        // ranks are zero based, NW Buddy stores the displayed level (1..20).
        // weapons never used are not part of the snapshot
        value: Math.min((entry?.rank ?? 0) + 1, NW_MAX_WEAPON_LEVEL),
      })
    }
  }

  const tradeskills: LedgerImportRow[] = []
  for (const skill of NW_TRADESKILLS_INFOS) {
    const entry = lookup(skill.ID)
    // the snapshot only lists progressions the character ever gained experience in
    tradeskills.push({ id: skill.ID, label: skill.ID, value: entry?.rank ?? 0 })
  }

  const territories: LedgerImportRow[] = []
  for (const territory of source.territories) {
    const id = String(territory.id)
    const entry = lookup(id)
    if (entry && !territories.some((it) => it.id === id)) {
      territories.push({ id, label: territory.label || id, value: entry.rank })
    }
  }

  let faction: CharacterRecord['faction'] = undefined
  let factionScore = -1
  for (const it of FACTIONS) {
    const entry = lookup(it.id)
    const score = entry ? entry.rank * 1e12 + entry.xp : -1
    if (entry && score > factionScore) {
      faction = it.value
      factionScore = score
    }
  }

  const equipment = resolveEquipment(data.equipment, source.itemTables)

  return {
    fileName: file.name,
    data,
    name: data.name,
    level: data.level,
    faction,
    weapons,
    tradeskills,
    territories,
    equipment: equipment.rows,
    equipmentWarning: equipment.warning,
    skillTrees: resolveSkillTrees(data, source.abilities),
  }
}

function resolveSkillTrees(data: LedgerCharacterData, abilities: LedgerImportSource['abilities']): LedgerSkillTreeRow[] {
  if (!data.skills?.length || !abilities?.length) {
    return []
  }
  const abilityByCrc = new Map(abilities.map((it) => [nwCrc32(it.AbilityID), it]))
  const result: LedgerSkillTreeRow[] = []
  for (const weapon of NW_WEAPON_TYPES) {
    if (result.some((it) => it.weapon === weapon.WeaponTag)) {
      continue
    }
    const tableCrc = nwCrc32(weapon.ProgressionId)
    const tree1: string[] = []
    const tree2: string[] = []
    for (const selection of data.skills) {
      if (selection.tableCrc !== tableCrc) {
        continue
      }
      const ability = abilityByCrc.get(selection.abilityCrc)
      if (!ability || (ability.WeaponTag && ability.WeaponTag.toLowerCase() !== weapon.WeaponTag.toLowerCase())) {
        continue
      }
      if (ability.TreeId === 0) {
        tree1.push(ability.AbilityID)
      } else if (ability.TreeId === 1) {
        tree2.push(ability.AbilityID)
      }
    }
    if (tree1.length || tree2.length) {
      result.push({ weapon: weapon.WeaponTag, label: weapon.UIName, tree1, tree2 })
    }
  }
  return result
}

function buildItemRegistry(tables: Array<{ uri: string; rows: MasterItemDefinitions[] }>) {
  const fileName = (uri: string) => uri.split('/').pop()
  const sorted = tables
    .filter((it) => !it.uri.includes('/mtx/') && !it.uri.includes('isleofnight'))
    .filter((it) => fileName(it.uri).startsWith('javelindata_itemdefinitions_master_'))
    .sort((a, b) => (fileName(a.uri) < fileName(b.uri) ? -1 : 1))
  const rows: MasterItemDefinitions[] = []
  let gapStart: number = null
  for (const table of sorted) {
    rows.push(...table.rows)
    if (fileName(table.uri) === ITEM_REGISTRY_GAP_AFTER) {
      gapStart = rows.length
    }
  }
  return (index: number): MasterItemDefinitions => {
    let j = index - ITEM_REGISTRY_BASE
    if (gapStart != null && j >= gapStart) {
      j -= ITEM_REGISTRY_GAP
      if (j < gapStart) {
        return null
      }
    }
    return rows[j] ?? null
  }
}

function resolveEquipment(
  records: LedgerItemRecord[],
  tables: LedgerImportSource['itemTables'],
): { rows: LedgerEquipmentRow[]; warning?: string } {
  if (!records?.length) {
    return { rows: [], warning: 'No equipment found in the capture.' }
  }
  if (!tables?.length) {
    return { rows: [], warning: 'Item tables not available.' }
  }
  const lookup = buildItemRegistry(tables)
  const items = records.map((record) => ({ record, item: lookup(record.index) }))

  // The item index depends on the game data version. Verify the mapping by comparing durability values.
  const durable = items.filter((it) => it.record.durability > 0)
  const matching = durable.filter((it) => it.item && Number(it.item.Durability) === it.record.durability)
  if (!durable.length || matching.length / durable.length < 0.9) {
    return {
      rows: [],
      warning:
        'Equipment could not be resolved. The item data of NW Buddy does not match the game version of the capture.',
    }
  }

  const rows: LedgerEquipmentRow[] = []
  for (const { record, item } of items) {
    if (!item || !record.gearScore) {
      continue
    }
    const classes = new Set<string>(item.ItemClass || [])
    const slot = EQUIP_SLOTS.find((slot) => {
      if (rows.some((it) => it.slot === slot.id)) {
        return false
      }
      const fits = (list: string[]) => !!list?.length && list.every((it) => classes.has(it))
      return fits(slot.itemClass) || fits(slot.itemClass2)
    })
    if (slot) {
      const weaponClass = Object.keys(ITEM_CLASS_TO_WEAPON_TAG).find((it) => classes.has(it))
      const weapon = NW_WEAPON_TYPES.find((it) => it.WeaponTag === ITEM_CLASS_TO_WEAPON_TAG[weaponClass])
      rows.push({
        slot: slot.id,
        itemId: item.ItemID,
        name: item.Name,
        gearScore: record.gearScore,
        weaponTag: weapon?.WeaponTag,
      })
    }
  }
  return { rows }
}

/**
 * Creates a gear set record from the equipped items. Perks are not resolved yet, so items keep their default perks.
 */
export function ledgerGearset(result: LedgerImportResult): Partial<GearsetRecord> {
  const slots: GearsetRecord['slots'] = {}
  for (const row of result.equipment) {
    slots[row.slot] = { itemId: row.itemId, gearScore: row.gearScore, perks: {} }
  }
  // skill trees of the equipped weapons
  const skills: GearsetRecord['skills'] = {}
  const equipped = [
    { ref: 'primary' as const, slot: 'weapon1' },
    { ref: 'secondary' as const, slot: 'weapon2' },
  ]
  for (const { ref, slot } of equipped) {
    const item = result.equipment.find((it) => it.slot === slot)
    const tree = item ? result.skillTrees.find((it) => it.weapon === item.weaponTag) : null
    if (tree) {
      skills[ref] = { weapon: tree.weapon, tree1: tree.tree1, tree2: tree.tree2 }
    }
  }
  return {
    name: `${result.name || 'Character'} (capture ${result.data.capturedAt?.toLocaleDateString() ?? ''})`.trim(),
    createMode: 'copy',
    slots,
    skills,
    level: result.level,
    tags: ['import'],
  }
}

/**
 * Merges the import into an existing character record. Notes and tags of territories are kept.
 */
export function applyLedgerImport(record: Partial<CharacterRecord>, result: LedgerImportResult): Partial<CharacterRecord> {
  const progressionLevels = { ...(record?.progressionLevels || {}) }
  for (const row of [...result.weapons, ...result.tradeskills]) {
    progressionLevels[row.id] = row.value
  }
  const territories = { ...(record?.territories || {}) }
  for (const row of result.territories) {
    territories[row.id] = { ...(territories[row.id] || {}), standing: row.value }
  }
  const update: Partial<CharacterRecord> = {
    progressionLevels,
    territories,
  }
  if (result.name) {
    update.name = result.name
  }
  if (result.level) {
    update.level = result.level
  }
  if (result.faction) {
    update.faction = result.faction
  }
  return update
}

async function readLedgerBytes(file: File): Promise<Uint8Array> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (isLedger(bytes)) {
    return bytes
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(bytes)
    const entry = Object.values(zip.files).find((it) => !it.dir && /(^|\/)ledger\.bin$/i.test(it.name))
    if (!entry) {
      throw new LedgerFormatError('The zip file does not contain a ledger.bin')
    }
    return entry.async('uint8array')
  }
  throw new LedgerFormatError('Not a New World capture (expected ledger.bin or a capture zip)')
}
