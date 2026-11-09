/**
 * Reader for New World network captures (`ledger.bin` written by the nw_capture tool,
 * see https://github.com/openworldserver/linux-capture).
 *
 * The capture already contains plaintext (the tool hooks SSL_read/SSL_write inside the game),
 * so no decryption is involved. Layout (reverse engineered, see also FunkyPaul/nw-prices):
 *
 *   file    = records: "NWDL" | u64 LE ts | u32 LE dir | u32 | u32 | u32 LE len | payload
 *             dir 1 = client -> server, dir 0 = server -> client
 *   payload = u8 (0x80 raw / 0x81 LZ4 block) | u8 | u16 BE seq | body
 *   body    = chunks: u8 flags | u16 BE len | [u8 channel if 0x20] | [u16 frag if 0x04] | [u16 if !0x08] | u16 | data
 *             channel 0 = RPC, 1 = replication, 3 = acks. Chunks flagged 0x04 are fragments of one message.
 */

export interface LedgerMessage {
  /** 0 = server to client, 1 = client to server */
  dir: number
  /** network channel */
  ch: number
  /** capture timestamp of the first fragment (ms) */
  ts: number
  data: Uint8Array
}

export class LedgerFormatError extends Error {}

const MAGIC = [0x4e, 0x57, 0x44, 0x4c] // "NWDL"
const RECORD_HEADER_SIZE = 28

export function isLedger(data: Uint8Array) {
  return data.length >= 4 && MAGIC.every((b, i) => data[i] === b)
}

/**
 * Decompresses a raw LZ4 block (no frame header).
 */
export function lz4Block(src: Uint8Array): Uint8Array {
  let out = new Uint8Array(Math.max(256, src.length * 4))
  let o = 0
  let i = 0
  const n = src.length
  const ensure = (size: number) => {
    if (o + size <= out.length) {
      return
    }
    let len = out.length * 2
    while (len < o + size) {
      len *= 2
    }
    const next = new Uint8Array(len)
    next.set(out.subarray(0, o))
    out = next
  }
  while (i < n) {
    const token = src[i++]
    let literals = token >> 4
    if (literals === 15) {
      let b = 255
      while (b === 255 && i < n) {
        b = src[i++]
        literals += b
      }
    }
    ensure(literals)
    out.set(src.subarray(i, i + literals), o)
    o += literals
    i += literals
    if (i >= n) {
      break
    }
    const offset = src[i] | (src[i + 1] << 8)
    i += 2
    if (offset === 0 || offset > o) {
      throw new LedgerFormatError('LZ4: invalid offset')
    }
    let match = token & 15
    if (match === 15) {
      let b = 255
      while (b === 255 && i < n) {
        b = src[i++]
        match += b
      }
    }
    match += 4
    ensure(match)
    let from = o - offset
    for (let k = 0; k < match; k++) {
      out[o++] = out[from++]
    }
  }
  return out.subarray(0, o)
}

/**
 * Reads all records, decompresses them, splits them into chunks and reassembles fragmented messages.
 *
 * @param filter optional filter to keep only some messages (saves memory on large captures)
 */
export function readLedgerMessages(data: Uint8Array, filter?: (dir: number, ch: number) => boolean): LedgerMessage[] {
  if (!isLedger(data)) {
    throw new LedgerFormatError('Not a New World capture (missing NWDL header)')
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const result: LedgerMessage[] = []
  const pending = new Map<string, Array<{ ts: number; data: Uint8Array }>>()
  const lastChannel = new Map<number, number>()

  let off = 0
  while (off + RECORD_HEADER_SIZE <= data.length) {
    if (!MAGIC.every((b, i) => data[off + i] === b)) {
      throw new LedgerFormatError(`Corrupt capture at offset 0x${off.toString(16)}`)
    }
    const ts = Number(view.getBigUint64(off + 4, true))
    const dir = view.getUint32(off + 12, true)
    const len = view.getUint32(off + 24, true)
    const payload = data.subarray(off + RECORD_HEADER_SIZE, off + RECORD_HEADER_SIZE + len)
    off += RECORD_HEADER_SIZE + len

    if (payload.length < 4 || (payload[0] !== 0x80 && payload[0] !== 0x81)) {
      continue
    }
    let body: Uint8Array
    try {
      body = payload[0] === 0x80 ? payload.subarray(4) : lz4Block(payload.subarray(4))
    } catch {
      continue
    }

    let j = 0
    while (j + 5 <= body.length) {
      const flags = body[j]
      const length = (body[j + 1] << 8) | body[j + 2]
      let k = j + 3
      let ch: number = null
      if (flags & 0x20) {
        ch = body[k]
        k += 1
      }
      if (flags & 0x04) {
        k += 2
      }
      if (!(flags & 0x08)) {
        k += 2
      }
      k += 2
      if (ch == null) {
        ch = flags & 0x01 ? 0 : lastChannel.get(dir)
      }
      lastChannel.set(dir, ch)
      const chunk = body.subarray(k, k + length)
      if (chunk.length !== length) {
        break
      }
      j = k + length

      const key = `${dir}:${ch}`
      if (flags & 0x04) {
        if (!pending.has(key)) {
          pending.set(key, [])
        }
        pending.get(key).push({ ts, data: chunk })
        continue
      }
      const parts = pending.get(key) || []
      pending.delete(key)
      if (filter && !filter(dir, ch)) {
        continue
      }
      parts.push({ ts, data: chunk })
      result.push({
        dir,
        ch,
        ts: parts[0].ts,
        data: parts.length === 1 ? chunk.slice() : concat(parts.map((it) => it.data)),
      })
    }
  }
  return result
}

function concat(parts: Uint8Array[]) {
  const size = parts.reduce((sum, it) => sum + it.length, 0)
  const out = new Uint8Array(size)
  let o = 0
  for (const part of parts) {
    out.set(part, o)
    o += part.length
  }
  return out
}

/**
 * Prefix coded variable integer used by the game's replication serializer:
 * `0xxxxxxx` (1 byte), `10xxxxxx` + 1 byte, `110xxxxx` + 2 bytes, `1110xxxx` + 3 bytes, `11110xxx` + 4 bytes.
 */
export function readPrefixVarint(data: Uint8Array, o: number): { value: number; size: number } {
  const f = data[o]
  if (f == null) {
    return null
  }
  if (f < 0x80) {
    return { value: f, size: 1 }
  }
  if (f < 0xc0) {
    return { value: (data[o + 1] << 6) | (f & 0x3f), size: 2 }
  }
  if (f < 0xe0) {
    return { value: (((data[o + 1] << 8) | data[o + 2]) << 5) | (f & 0x1f), size: 3 }
  }
  if (f < 0xf0) {
    return { value: ((data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) * 16 + (f & 0x0f), size: 4 }
  }
  return {
    value: ((data[o + 1] << 24) >>> 0) * 8 + ((data[o + 2] << 16) | (data[o + 3] << 8) | data[o + 4]) * 8 + (f & 0x07),
    size: 5,
  }
}

export function encodePrefixVarint(value: number): number[] {
  if (value < 0x80) {
    return [value]
  }
  if (value < 1 << 14) {
    return [0x80 | (value & 0x3f), value >> 6]
  }
  if (value < 1 << 21) {
    const hi = value >> 5
    return [0xc0 | (value & 0x1f), (hi >> 8) & 0xff, hi & 0xff]
  }
  throw new Error('value too large')
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/**
 * CRC32 of the lower cased string. This is how the game hashes ids on the wire (AZ::Crc32).
 */
export function nwCrc32(value: string): number {
  const bytes = new TextEncoder().encode(value.toLowerCase())
  let crc = 0xffffffff
  for (const b of bytes) {
    crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
