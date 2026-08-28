/**
 * HWPX 재패키징.
 *
 * 원칙: **바뀌지 않은 항목은 압축된 바이트 그대로 복사한다.**
 * 다시 압축하지 않으므로 이미지와 나머지 리소스는 원본과 바이트 단위로 같고,
 * 속도도 빠르다. 새로 쓰는 건 실제로 수정된 section XML뿐이다.
 *
 * 엔트리 순서, 항목별 압축 방식, 타임스탬프, 권한 비트도 원본에서 그대로 옮긴다.
 * HWPX는 `mimetype`이 첫 항목이고 무압축이어야 하는데, 순서를 그대로 두면
 * 따로 신경 쓸 필요가 없다.
 */

import { COMPRESSION_DEFLATE, COMPRESSION_STORED, ZipArchive, ZipError, type ZipEntry } from './zip'

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

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new ZipError('이 브라우저는 CompressionStream을 지원하지 않습니다.')
  }
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

interface PreparedEntry {
  readonly source: ZipEntry
  readonly payload: Uint8Array
  readonly compressionMethod: number
  readonly crc: number
  readonly uncompressedSize: number
}

/**
 * `replacements`에 있는 항목만 새 내용으로 바꾸고 나머지는 그대로 둔 채
 * 새 ZIP 바이트를 만든다.
 */
export async function repackage(
  archive: ZipArchive,
  replacements: ReadonlyMap<string, Uint8Array>,
): Promise<Uint8Array> {
  for (const name of replacements.keys()) {
    if (!archive.has(name)) throw new ZipError(`원본에 없는 항목은 바꿀 수 없습니다: ${name}`)
  }

  const prepared: PreparedEntry[] = []
  for (const entry of archive.entries) {
    const replacement = replacements.get(entry.name)
    if (replacement === undefined) {
      // 손대지 않는 항목: 압축된 바이트를 그대로 옮긴다. 재압축하지 않는다.
      prepared.push({
        source: entry,
        payload: archive.rawBytes(entry),
        compressionMethod: entry.compressionMethod,
        crc: entry.crc32,
        uncompressedSize: entry.uncompressedSize,
      })
      continue
    }
    // 바뀐 항목: 원본과 같은 압축 방식으로 다시 쓴다.
    const stored = entry.compressionMethod === COMPRESSION_STORED
    prepared.push({
      source: entry,
      payload: stored ? replacement : await deflateRaw(replacement),
      compressionMethod: stored ? COMPRESSION_STORED : COMPRESSION_DEFLATE,
      crc: crc32(replacement),
      uncompressedSize: replacement.byteLength,
    })
  }

  return assemble(prepared, archive.comment)
}

function assemble(entries: readonly PreparedEntry[], comment: Uint8Array): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.source.name)

    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    // 로컬 헤더에 크기를 직접 적으므로 data descriptor 플래그(bit 3)는 꺼 둔다.
    localView.setUint16(6, entry.source.generalPurposeFlags & ~0x0008, true)
    localView.setUint16(8, entry.compressionMethod, true)
    localView.setUint16(10, entry.source.dosTime, true)
    localView.setUint16(12, entry.source.dosDate, true)
    localView.setUint32(14, entry.crc, true)
    localView.setUint32(18, entry.payload.byteLength, true)
    localView.setUint32(22, entry.uncompressedSize, true)
    localView.setUint16(26, nameBytes.length, true)
    localView.setUint16(28, 0, true)
    local.set(nameBytes, 30)
    parts.push(local, entry.payload)

    const record = new Uint8Array(46 + nameBytes.length)
    const recordView = new DataView(record.buffer)
    recordView.setUint32(0, 0x02014b50, true)
    recordView.setUint16(4, entry.source.versionMadeBy, true)
    recordView.setUint16(6, 20, true)
    recordView.setUint16(8, entry.source.generalPurposeFlags & ~0x0008, true)
    recordView.setUint16(10, entry.compressionMethod, true)
    recordView.setUint16(12, entry.source.dosTime, true)
    recordView.setUint16(14, entry.source.dosDate, true)
    recordView.setUint32(16, entry.crc, true)
    recordView.setUint32(20, entry.payload.byteLength, true)
    recordView.setUint32(24, entry.uncompressedSize, true)
    recordView.setUint16(28, nameBytes.length, true)
    recordView.setUint16(30, 0, true)
    recordView.setUint16(32, 0, true)
    recordView.setUint16(34, 0, true)
    recordView.setUint16(36, entry.source.internalAttributes, true)
    recordView.setUint32(38, entry.source.externalAttributes, true)
    recordView.setUint32(42, offset, true)
    record.set(nameBytes, 46)
    central.push(record)

    offset += local.byteLength + entry.payload.byteLength
  }

  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0)
  const end = new Uint8Array(22 + comment.byteLength)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
  endView.setUint16(20, comment.byteLength, true)
  end.set(comment, 22)

  const total =
    parts.reduce((sum, part) => sum + part.byteLength, 0) + centralSize + end.byteLength
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of [...parts, ...central, end]) {
    out.set(part, cursor)
    cursor += part.byteLength
  }
  return out
}
