/**
 * 의존성 없는 ZIP 리더.
 *
 * HWPX는 ZIP 패키지다. 미리보기에 필요한 건 `Contents/*.xml` 몇 개뿐이고,
 * 용량의 대부분을 차지하는 `BinData/` 이미지는 건드릴 필요가 없다.
 * 그래서 중앙 디렉터리만 먼저 읽어 목록을 잡고, 실제로 필요한 엔트리만
 * 그때그때 펼친다. 이게 이전 편집기 대비 로딩이 빨라지는 핵심 이유다.
 *
 * 나중에 patch engine이 결과 파일을 다시 쓸 때 원본과 동일한 엔트리 순서/
 * 압축 방식/타임스탬프를 재현해야 하므로, 여기서 그 정보를 모두 보존한다.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

const EOCD_MIN_SIZE = 22
/** ZIP 주석은 최대 65535바이트라 EOCD는 파일 끝 64KB 안에 반드시 있다. */
const MAX_COMMENT_SIZE = 0xffff

export const COMPRESSION_STORED = 0
export const COMPRESSION_DEFLATE = 8

export class ZipError extends Error {
  override name = 'ZipError'
}

export interface ZipEntry {
  /** 중앙 디렉터리에 나온 순서. 재패키징 시 이 순서를 지켜야 한다. */
  readonly index: number
  readonly name: string
  readonly compressionMethod: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly crc32: number
  /** DOS 형식 그대로. 재패키징 때 그대로 되돌려 쓴다. */
  readonly dosTime: number
  readonly dosDate: number
  readonly externalAttributes: number
  readonly internalAttributes: number
  readonly versionMadeBy: number
  readonly generalPurposeFlags: number
  readonly localHeaderOffset: number
  readonly isDirectory: boolean
}

export class ZipArchive {
  private constructor(
    private readonly bytes: Uint8Array,
    readonly entries: readonly ZipEntry[],
    readonly comment: Uint8Array,
  ) {}

  static open(buffer: ArrayBuffer | Uint8Array): ZipArchive {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    if (bytes.byteLength < EOCD_MIN_SIZE) {
      throw new ZipError('파일이 너무 작습니다. ZIP 형식이 아닙니다.')
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const eocd = findEndOfCentralDirectory(bytes, view)
    const entryCount = view.getUint16(eocd + 10, true)
    const centralOffset = view.getUint32(eocd + 16, true)
    const commentLength = view.getUint16(eocd + 20, true)
    const comment = bytes.subarray(eocd + 22, eocd + 22 + commentLength)

    if (entryCount === 0xffff || centralOffset === 0xffffffff) {
      throw new ZipError('ZIP64 아카이브는 지원하지 않습니다.')
    }

    const entries: ZipEntry[] = []
    let cursor = centralOffset
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > bytes.byteLength) {
        throw new ZipError('중앙 디렉터리가 잘려 있습니다.')
      }
      if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
        throw new ZipError(`중앙 디렉터리 항목 ${index}의 서명이 올바르지 않습니다.`)
      }
      const nameLength = view.getUint16(cursor + 28, true)
      const extraLength = view.getUint16(cursor + 30, true)
      const entryCommentLength = view.getUint16(cursor + 32, true)
      const name = decodeName(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
      entries.push({
        index,
        name,
        versionMadeBy: view.getUint16(cursor + 4, true),
        generalPurposeFlags: view.getUint16(cursor + 8, true),
        compressionMethod: view.getUint16(cursor + 10, true),
        dosTime: view.getUint16(cursor + 12, true),
        dosDate: view.getUint16(cursor + 14, true),
        crc32: view.getUint32(cursor + 16, true),
        compressedSize: view.getUint32(cursor + 20, true),
        uncompressedSize: view.getUint32(cursor + 24, true),
        internalAttributes: view.getUint16(cursor + 36, true),
        externalAttributes: view.getUint32(cursor + 38, true),
        localHeaderOffset: view.getUint32(cursor + 42, true),
        isDirectory: name.endsWith('/'),
      })
      cursor += 46 + nameLength + extraLength + entryCommentLength
    }

    return new ZipArchive(bytes, entries, comment)
  }

  find(name: string): ZipEntry | undefined {
    return this.entries.find((entry) => entry.name === name)
  }

  has(name: string): boolean {
    return this.find(name) !== undefined
  }

  /** 압축을 풀지 않고 저장된 그대로의 바이트를 돌려준다. */
  rawBytes(entry: ZipEntry): Uint8Array {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
    const header = entry.localHeaderOffset
    if (header + 30 > this.bytes.byteLength) {
      throw new ZipError(`${entry.name}: 로컬 헤더가 파일 밖을 가리킵니다.`)
    }
    if (view.getUint32(header, true) !== LOCAL_SIGNATURE) {
      throw new ZipError(`${entry.name}: 로컬 헤더 서명이 올바르지 않습니다.`)
    }
    const nameLength = view.getUint16(header + 26, true)
    const extraLength = view.getUint16(header + 28, true)
    const start = header + 30 + nameLength + extraLength
    const end = start + entry.compressedSize
    if (end > this.bytes.byteLength) {
      throw new ZipError(`${entry.name}: 데이터가 파일 끝을 넘어갑니다.`)
    }
    return this.bytes.subarray(start, end)
  }

  async read(nameOrEntry: string | ZipEntry): Promise<Uint8Array> {
    const entry =
      typeof nameOrEntry === 'string' ? this.find(nameOrEntry) : nameOrEntry
    if (!entry) {
      throw new ZipError(`항목을 찾을 수 없습니다: ${String(nameOrEntry)}`)
    }
    const raw = this.rawBytes(entry)
    if (entry.compressionMethod === COMPRESSION_STORED) {
      return raw
    }
    if (entry.compressionMethod === COMPRESSION_DEFLATE) {
      return inflateRaw(raw, entry.uncompressedSize)
    }
    throw new ZipError(
      `${entry.name}: 지원하지 않는 압축 방식(${entry.compressionMethod})입니다.`,
    )
  }

  async readText(nameOrEntry: string | ZipEntry): Promise<string> {
    return new TextDecoder('utf-8').decode(await this.read(nameOrEntry))
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  const limit = Math.max(0, bytes.byteLength - EOCD_MIN_SIZE - MAX_COMMENT_SIZE)
  for (let offset = bytes.byteLength - EOCD_MIN_SIZE; offset >= limit; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      return offset
    }
  }
  throw new ZipError('ZIP 중앙 디렉터리를 찾지 못했습니다. 손상되었거나 ZIP이 아닙니다.')
}

function decodeName(raw: Uint8Array): string {
  return new TextDecoder('utf-8').decode(raw)
}

/**
 * raw deflate 해제. 브라우저와 Node 모두 표준 `DecompressionStream`을 쓴다.
 * (별도 라이브러리를 넣지 않는 이유다.)
 */
export async function inflateRaw(data: Uint8Array, expectedSize?: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError(
      '이 브라우저는 DecompressionStream을 지원하지 않습니다. 최신 브라우저를 사용해 주세요.',
    )
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const inflated = new Uint8Array(await new Response(stream).arrayBuffer())
  if (expectedSize !== undefined && inflated.byteLength !== expectedSize) {
    throw new ZipError(
      `압축 해제 크기가 맞지 않습니다. 기대 ${expectedSize}, 실제 ${inflated.byteLength}`,
    )
  }
  return inflated
}
