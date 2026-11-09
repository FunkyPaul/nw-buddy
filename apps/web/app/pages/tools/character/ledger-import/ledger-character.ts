import { LedgerMessage, encodePrefixVarint, readLedgerMessages, readPrefixVarint } from './ledger-parser'

/**
 * Type indices of replicated component states (see Coldzer0/Aeternum-World Catalog/uuid_to_class.json).
 * They are written as prefix varint right in front of the component body.
 */
const TYPE_CATEGORICAL_PROGRESSION = 911 // MB::CategoricalProgressionReplicatedState
const TYPE_PROGRESSION = 899 // MB::ProgressionComponentReplicatedState
const TYPE_PLAYER = 3935 // MB::PlayerComponentReplicatedState
const TYPE_PAPERDOLL = 3183 // MB::PaperdollComponentReplicatedState
const TYPE_PROGRESSION_POINTS = 3681 // MB::ProgressionPointReplicatedState

/**
 * A selected skill tree node: `crc32(<Weapon>AbilityTable)` and `crc32(AbilityID)`.
 */
export interface LedgerSkillSelection {
  tableCrc: number
  abilityCrc: number
}

/**
 * Compact item descriptor as replicated in the paperdoll / inventory components.
 *
 *   3a 16 | u32 BE key | durability | ? | gear score | perk values... (all prefix varints)
 *
 * The key packs the item definition index together with the durability:
 * `(key & 0x3fffffff) = index * 8001 + durability + 5848`. The index addresses the game's item definition
 * registry (MasterItemDefinitions tables in file order, see `ledger-import.ts`).
 */
export interface LedgerItemRecord {
  /** index into the game's item definition registry */
  index: number
  durability: number
  gearScore: number
  /** raw perk values (not resolved yet) */
  perks: number[]
}

const ITEM_KEY_RADIX = 8001
const ITEM_KEY_OFFSET = 5848

export interface LedgerProgressionEntry {
  /** CRC32 of the lower cased CategoricalProgressionId */
  crc: number
  /** resolved CategoricalProgressionId, if known */
  id?: string
  /** zero based rank as sent by the server */
  rank: number
  /** experience within the current rank */
  xp: number
}

export interface LedgerCharacterData {
  name?: string
  /** character level (1 based) */
  level?: number
  /** total character experience */
  xp?: number
  progression: LedgerProgressionEntry[]
  /** equipped items (paperdoll), in replication order */
  equipment: LedgerItemRecord[]
  /** selected skill tree nodes of all weapons (and territory bonuses) */
  skills: LedgerSkillSelection[]
  /** capture time of the snapshot */
  capturedAt?: Date
}

export class LedgerCharacterNotFoundError extends Error {}

/**
 * Extracts the local player's character data from a capture.
 *
 * The server sends a full state of the own player entity when entering the world. That snapshot contains the
 * categorical progression (tradeskills, weapon mastery, standing...), which is only replicated to the owner.
 * The other components of the same entity follow within the same message.
 *
 * @param resolveCrc maps a crc32 to the id it was computed from (used to validate the progression block)
 */
export function extractLedgerCharacter(
  data: Uint8Array,
  resolveCrc: (crc: number) => string | undefined,
): LedgerCharacterData {
  const messages = readLedgerMessages(data, (dir, ch) => dir === 0 && ch === 1)
  for (const message of messages) {
    const found = findCategoricalProgression(message.data, resolveCrc)
    if (!found) {
      continue
    }
    const result: LedgerCharacterData = {
      progression: found.entries,
      equipment: findPaperdollItems(message.data, found.end),
      skills: findSkillSelections(message.data, found.end),
      capturedAt: message.ts ? new Date(message.ts) : undefined,
    }
    const progression = findProgression(message.data, found.end)
    if (progression) {
      result.level = progression.level
      result.xp = progression.xp
    }
    result.name = findPlayerName(message.data, found.end) ?? findPlayerName(message.data, 0)
    return result
  }
  throw new LedgerCharacterNotFoundError(
    'No character snapshot found. Start the capture before selecting the character (before entering the world).',
  )
}

function* findTypeMarkers(data: Uint8Array, typeIndex: number, from = 0) {
  const marker = encodePrefixVarint(typeIndex)
  outer: for (let i = Math.max(1, from); i + marker.length < data.length; i++) {
    for (let k = 0; k < marker.length; k++) {
      if (data[i + k] !== marker[k]) {
        continue outer
      }
    }
    yield i + marker.length
  }
}

/**
 * Body layout:
 *
 *   01 07                       group mask, member mask (members 0..2 present)
 *   00 01 05 <n>  n x u32 BE    progression id crc
 *   00 01 05 <n>  n x u16 BE    rank
 *   00 01 05 <n>  n x u64 BE    experience
 */
function findCategoricalProgression(data: Uint8Array, resolveCrc: (crc: number) => string | undefined) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (const start of findTypeMarkers(data, TYPE_CATEGORICAL_PROGRESSION)) {
    let p = start + 2
    const readHeader = (): number => {
      if (data[p] !== 0x00 || data[p + 1] !== 0x01 || data[p + 2] !== 0x05) {
        return null
      }
      const count = readPrefixVarint(data, p + 3)
      if (!count) {
        return null
      }
      p += 3 + count.size
      return count.value
    }
    const n = readHeader()
    if (!n || p + n * 4 > data.length) {
      continue
    }
    const ids: number[] = []
    for (let i = 0; i < n; i++) {
      ids.push(view.getUint32(p + i * 4))
    }
    p += n * 4
    if (readHeader() !== n || p + n * 2 > data.length) {
      continue
    }
    const ranks: number[] = []
    for (let i = 0; i < n; i++) {
      ranks.push(view.getUint16(p + i * 2))
    }
    p += n * 2
    if (readHeader() !== n || p + n * 8 > data.length) {
      continue
    }
    const xps: number[] = []
    for (let i = 0; i < n; i++) {
      xps.push(Number(view.getBigUint64(p + i * 8)))
    }
    p += n * 8
    const entries = ids.map((crc, i): LedgerProgressionEntry => {
      return { crc, id: resolveCrc(crc), rank: ranks[i], xp: xps[i] }
    })
    // require that the block actually looks like progression data
    if (entries.filter((it) => !!it.id).length < Math.min(5, n)) {
      continue
    }
    return { entries, end: p }
  }
  return null
}

/**
 * Body layout: `<member mask> 01 <u32 BE level index> [03 <u32 BE xp> <u32 BE>]`
 */
function findProgression(data: Uint8Array, from: number) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (const p of findTypeMarkers(data, TYPE_PROGRESSION, from)) {
    const memberMask = data[p]
    if (!(memberMask & 0x01) || memberMask > 0x03 || data[p + 1] !== 0x01 || p + 6 > data.length) {
      continue
    }
    const levelIndex = view.getUint32(p + 2)
    if (levelIndex > 200) {
      continue
    }
    let xp: number = undefined
    if (memberMask & 0x02 && data[p + 6] & 0x01 && p + 11 <= data.length) {
      xp = view.getUint32(p + 7)
    }
    return { level: levelIndex + 1, xp }
  }
  return null
}

/**
 * The player component contains the character GUID followed by the length prefixed character name.
 */
function findPlayerName(data: Uint8Array, from: number) {
  for (const p of findTypeMarkers(data, TYPE_PLAYER, from)) {
    const end = Math.min(data.length, p + 96)
    for (let i = p + 16; i < end; i++) {
      const len = data[i]
      if (len < 2 || len > 32 || i + 1 + len > data.length) {
        continue
      }
      // GUID v4 in front of the name
      if (data[i - 16 + 6] >> 4 !== 4) {
        continue
      }
      const bytes = data.subarray(i + 1, i + 1 + len)
      if (!bytes.every((b) => b >= 0x20 && b !== 0x7f)) {
        continue
      }
      try {
        const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (name.trim().length >= 2) {
          return name
        }
      } catch {
        // not a valid string
      }
    }
  }
  return undefined
}

/**
 * Reads one compact item descriptor at `o` (pointing at the `3a 16` marker).
 */
export function readItemRecord(data: Uint8Array, o: number): { record: LedgerItemRecord; end: number } {
  if (data[o] !== 0x3a || data[o + 1] !== 0x16 || o + 10 > data.length) {
    return null
  }
  let p = o + 2
  const key = ((data[p] << 24) >>> 0) + ((data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3])
  if (key >>> 30 !== 2) {
    return null
  }
  p += 4
  const durability = readPrefixVarint(data, p)
  if (!durability) {
    return null
  }
  p += durability.size
  const unknown = readPrefixVarint(data, p)
  if (!unknown) {
    return null
  }
  p += unknown.size
  const gearScore = readPrefixVarint(data, p)
  if (!gearScore) {
    return null
  }
  p += gearScore.size
  const packed = (key & 0x3fffffff) - durability.value - ITEM_KEY_OFFSET
  if (packed < 0 || packed % ITEM_KEY_RADIX !== 0 || gearScore.value > 2000) {
    return null
  }
  const perks: number[] = []
  while (p < data.length && data[p] !== 0 && perks.length < 8) {
    const perk = readPrefixVarint(data, p)
    if (!perk) {
      break
    }
    perks.push(perk.value)
    p += perk.size
  }
  return {
    record: {
      index: packed / ITEM_KEY_RADIX,
      durability: durability.value,
      gearScore: gearScore.value,
      perks,
    },
    end: p,
  }
}

/**
 * Paperdoll body: `06 ff | 00 01 05 <n> n x u32 | 00 01 05 <n> n x item | 00 01 05 <m> m x item | 00 01 05 <m> m x u32 slot | ...`
 * Collects all item records until the slot index list starts.
 */
function findPaperdollItems(data: Uint8Array, from: number): LedgerItemRecord[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (const start of findTypeMarkers(data, TYPE_PAPERDOLL, from)) {
    if (data[start] !== 0x06 || data[start + 2] !== 0x00 || data[start + 3] !== 0x01 || data[start + 4] !== 0x05) {
      continue
    }
    const items: LedgerItemRecord[] = []
    let i = start + 2
    while (i < data.length - 8) {
      if (items.length && data[i] === 0x00 && data[i + 1] === 0x01 && data[i + 2] === 0x05) {
        const n = data[i + 3]
        let slotList = n > 0 && n < 64 && i + 4 + n * 4 <= data.length
        for (let k = 0; slotList && k < n; k++) {
          slotList = view.getUint32(i + 4 + k * 4) < 64
        }
        if (slotList) {
          break
        }
      }
      const item = readItemRecord(data, i)
      if (item) {
        items.push(item.record)
        i = item.end
        continue
      }
      i++
    }
    if (items.length) {
      return items
    }
  }
  return []
}

/**
 * Progression point body:
 *
 *   01 0f
 *   00 01 05 <n>  n x u32 BE   progression table crc (weapon ability tables, territory rank bonus tables)
 *   00 01 05 <n>  n x u16 BE   points
 *   00 01 05 <n>  n x u8
 *   00 01 05 <m>  m x (u32 BE table crc, u32 BE ability crc, u8, u8)   selected nodes
 */
function findSkillSelections(data: Uint8Array, from: number): LedgerSkillSelection[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (const start of findTypeMarkers(data, TYPE_PROGRESSION_POINTS, from)) {
    let p = start + 2
    const readHeader = (): number => {
      if (data[p] !== 0x00 || data[p + 1] !== 0x01 || data[p + 2] !== 0x05) {
        return null
      }
      const count = readPrefixVarint(data, p + 3)
      if (!count) {
        return null
      }
      p += 3 + count.size
      return count.value
    }
    const n = readHeader()
    if (!n || p + n * 4 > data.length) {
      continue
    }
    const tables = new Set<number>()
    for (let i = 0; i < n; i++) {
      tables.add(view.getUint32(p + i * 4))
    }
    p += n * 4
    if (readHeader() !== n) {
      continue
    }
    p += n * 2
    if (readHeader() !== n) {
      continue
    }
    p += n
    const m = readHeader()
    if (!m || p + m * 10 > data.length) {
      continue
    }
    const result: LedgerSkillSelection[] = []
    for (let i = 0; i < m; i++) {
      const tableCrc = view.getUint32(p + i * 10)
      if (!tables.has(tableCrc)) {
        // not the structure we expect
        result.length = 0
        break
      }
      result.push({ tableCrc, abilityCrc: view.getUint32(p + i * 10 + 4) })
    }
    if (result.length) {
      return result
    }
  }
  return []
}

export type { LedgerMessage }
