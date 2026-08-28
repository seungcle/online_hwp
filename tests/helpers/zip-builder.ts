/**
 * 테스트용 최소 ZIP writer.
 *
 * 실제 한글이 만든 HWPX의 특징을 그대로 재현한다.
 *  - `mimetype`이 첫 항목이고 무압축(stored)
 *  - 항목마다 압축 방식이 다름
 *  - 타임스탬프가 1980-01-01로 고정된 항목이 섞임
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export interface BuildEntry {
  name: string
  data: string | Uint8Array
  /** 기본은 deflate. HWPX의 mimetype처럼 무압축이어야 하는 항목은 true. */
  stored?: boolean
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function buildZip(entries: readonly BuildEntry[]): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const local: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data
    const stored = entry.stored ?? false
    const payload = stored ? raw : await deflateRaw(raw)
    const nameBytes = encoder.encode(entry.name)
    const method = stored ? 0 : 8
    const checksum = crc32(raw)

    const header = new Uint8Array(30 + nameBytes.length)
    const headerView = new DataView(header.buffer)
    headerView.setUint32(0, 0x04034b50, true)
    headerView.setUint16(4, 20, true)
    headerView.setUint16(6, 0, true)
    headerView.setUint16(8, method, true)
    headerView.setUint16(10, 0, true) // dos time
    headerView.setUint16(12, 0x0021, true) // dos date = 1980-01-01
    headerView.setUint32(14, checksum, true)
    headerView.setUint32(18, payload.length, true)
    headerView.setUint32(22, raw.length, true)
    headerView.setUint16(26, nameBytes.length, true)
    headerView.setUint16(28, 0, true)
    header.set(nameBytes, 30)
    local.push(header, payload)

    const record = new Uint8Array(46 + nameBytes.length)
    const recordView = new DataView(record.buffer)
    recordView.setUint32(0, 0x02014b50, true)
    recordView.setUint16(4, 20, true)
    recordView.setUint16(6, 20, true)
    recordView.setUint16(8, 0, true)
    recordView.setUint16(10, method, true)
    recordView.setUint16(12, 0, true)
    recordView.setUint16(14, 0x0021, true)
    recordView.setUint32(16, checksum, true)
    recordView.setUint32(20, payload.length, true)
    recordView.setUint32(24, raw.length, true)
    recordView.setUint16(28, nameBytes.length, true)
    recordView.setUint16(30, 0, true)
    recordView.setUint16(32, 0, true)
    recordView.setUint16(34, 0, true)
    recordView.setUint16(36, 0, true)
    recordView.setUint32(38, 0o600 << 16, true)
    recordView.setUint32(42, offset, true)
    record.set(nameBytes, 46)
    central.push(record)

    offset += header.length + payload.length
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)

  return concat([...local, ...central, end])
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of parts) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out
}
