/**
 * HWPX 패키지 열기 → 검증 → 문서 모델 생성.
 *
 * 성능의 핵심: `BinData/` 이미지는 아예 건드리지 않는다.
 * 중앙 디렉터리로 목록만 읽고, 실제로 압축을 푸는 건 `Contents/section*.xml`
 * 뿐이다. 10MB 문서에서 실제로 해제하는 바이트는 보통 수백 KB 수준이다.
 */

import { Stopwatch } from '../perf'
import { ZipArchive, ZipError } from './zip'
import { buildDocumentModel, parseSection, type DocumentModel, type SectionModel } from './document'
import { parseManifest, type ManifestItem } from './manifest'

export class HwpxError extends Error {
  override name = 'HwpxError'
}

const REQUIRED_ENTRIES = [
  'mimetype',
  'version.xml',
  'Contents/header.xml',
  'Contents/content.hpf',
  'META-INF/container.xml',
] as const

const EXPECTED_MIMETYPE = 'application/hwp+zip'
const SECTION_PATTERN = /^Contents\/section(\d+)\.xml$/i
/** 구형 .hwp(OLE 복합 문서)의 시그니처. */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

export interface HwpxMeta {
  readonly fileName: string
  readonly fileSize: number
  readonly entryCount: number
  /** 압축을 실제로 푼 바이트 수. 파일 크기와 비교하면 절약분이 보인다. */
  readonly inflatedBytes: number
  readonly sectionNames: string[]
  readonly application?: string
}

export interface LoadResult {
  readonly model: DocumentModel
  readonly meta: HwpxMeta
  readonly timings: ReturnType<Stopwatch['report']>
  /** 원본 바이트. patch engine이 그대로 재사용한다. */
  readonly source: Uint8Array
  /** 열려 있는 ZIP. 이미지 지연 로딩과 재패키징에 그대로 쓴다. */
  readonly archive: ZipArchive
  /** section 파일 이름 → 압축을 푼 XML 바이트. */
  readonly sectionBytes: Map<string, Uint8Array>
  /** content.hpf manifest. 그림 id → 실제 ZIP 경로. */
  readonly manifest: Map<string, ManifestItem>
}

export async function loadHwpx(file: File, watch = new Stopwatch()): Promise<LoadResult> {
  if (!/\.hwpx$/i.test(file.name)) {
    if (/\.hwp$/i.test(file.name)) {
      throw new HwpxError(
        '구형 .hwp 형식은 지원하지 않습니다. 한글에서 "다른 이름으로 저장 → HWPX"로 변환해 주세요.',
      )
    }
    throw new HwpxError('.hwpx 파일만 열 수 있습니다.')
  }

  const buffer = new Uint8Array(await file.arrayBuffer())
  watch.lap('파일 읽기')

  return loadHwpxBytes(buffer, file.name, watch)
}

export async function loadHwpxBytes(
  buffer: Uint8Array,
  fileName: string,
  watch = new Stopwatch(),
): Promise<LoadResult> {
  if (startsWith(buffer, OLE_MAGIC)) {
    throw new HwpxError(
      '구형 .hwp 형식입니다. 한글에서 "다른 이름으로 저장 → HWPX"로 변환해 주세요.',
    )
  }

  let archive: ZipArchive
  try {
    archive = ZipArchive.open(buffer)
  } catch (error) {
    throw new HwpxError(
      error instanceof ZipError
        ? `HWPX를 열지 못했습니다: ${error.message}`
        : 'HWPX를 열지 못했습니다. 파일이 손상되었을 수 있습니다.',
    )
  }
  watch.lap('ZIP 목록 읽기')

  const missing = REQUIRED_ENTRIES.filter((name) => !archive.has(name))
  if (missing.length > 0) {
    throw new HwpxError(`HWPX 필수 구성요소가 없습니다: ${missing.join(', ')}`)
  }

  const mimetype = (await archive.readText('mimetype')).trim()
  if (mimetype !== EXPECTED_MIMETYPE) {
    throw new HwpxError(`HWPX가 아닙니다. mimetype이 "${mimetype}"입니다.`)
  }

  const sectionEntries = archive.entries
    .filter((entry) => SECTION_PATTERN.test(entry.name))
    .sort((a, b) => sectionNumber(a.name) - sectionNumber(b.name))
  if (sectionEntries.length === 0) {
    throw new HwpxError('본문(Contents/section*.xml)을 찾지 못했습니다.')
  }

  const sectionBytes = new Map<string, Uint8Array>()
  let inflatedBytes = 0
  for (const entry of sectionEntries) {
    const bytes = await archive.read(entry)
    inflatedBytes += bytes.byteLength
    sectionBytes.set(entry.name, bytes)
  }
  watch.lap('본문 압축 해제')

  const sections: SectionModel[] = sectionEntries.map((entry, index) =>
    parseSection(sectionBytes.get(entry.name)!, index, entry.name),
  )
  watch.lap('XML 파싱')

  const model = buildDocumentModel(sections)
  watch.lap('문서 모델 생성')

  const meta: HwpxMeta = {
    fileName,
    fileSize: buffer.byteLength,
    entryCount: archive.entries.length,
    inflatedBytes,
    sectionNames: sectionEntries.map((entry) => entry.name),
    application: await readApplication(archive),
  }

  const manifest = parseManifest(await archive.read('Contents/content.hpf'))

  return {
    model,
    meta,
    timings: watch.report(),
    source: buffer,
    archive,
    sectionBytes,
    manifest,
  }
}

async function readApplication(archive: ZipArchive): Promise<string | undefined> {
  try {
    const xml = await archive.readText('version.xml')
    const application = /application="([^"]*)"/.exec(xml)?.[1]
    const version = /appVersion="([^"]*)"/.exec(xml)?.[1]
    return [application, version].filter(Boolean).join(' ') || undefined
  } catch {
    return undefined
  }
}

function sectionNumber(name: string): number {
  return Number(SECTION_PATTERN.exec(name)?.[1] ?? 0)
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.byteLength < prefix.length) return false
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false
  }
  return true
}
