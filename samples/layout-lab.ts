/**
 * 레이아웃 실험실.
 *
 *   npm run layout:lab
 *
 * 같은 문서에 **똑같은 긴 텍스트 수정**을 넣고, 줄 배치 캐시만 다르게 다룬
 * 여러 벌을 만든다. 한글에서 나란히 열어 어느 쪽이 정상으로 보이는지 보면
 * "한글이 무엇을 다시 계산하고 무엇을 그대로 믿는가"가 드러난다.
 *
 * AI를 부르지 않는다. 수정 내용은 고정이다 — 변인은 캐시 처리 방식 하나뿐이어야
 * 한다. 높이 값을 추측해 적어 넣는 것이 목적이 아니라, **한글이 스스로 고쳐
 * 주는 범위를 재는 것**이 목적이다.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadHwpxBytes } from '../frontend/src/hwpx/package'
import { HwpxDocument } from '../frontend/src/hwpx/session'
import { parseSection, type Block, type ByteSpan, type TableCell } from '../frontend/src/hwpx/document'
import { spliceBytes, type EditOperation } from '../frontend/src/hwpx/patch'
import { ZipArchive } from '../frontend/src/hwpx/zip'
import { repackage } from '../frontend/src/hwpx/zip-writer'
import { collectParagraphs } from '../frontend/src/ai/client'

const inputDir = resolve(process.env['HWPX_SAMPLE_DIR'] ?? 'samples/local')
const outputDir = resolve('samples/output/layout')
const SOURCE =
  process.env['HWPX_SAMPLE_FILE'] ?? '00.과정개발보고서_보끄레_고객경험(CX) 대시보드 자동화.hwpx'

if (!existsSync(join(inputDir, SOURCE))) {
  console.error(`${join(inputDir, SOURCE)} 가 없습니다.`)
  process.exit(1)
}
mkdirSync(outputDir, { recursive: true })

const LONG = (n: number, seed: string): string =>
  Array.from({ length: n }, (_u, i) => `${seed} ${i + 1}번 항목의 세부 내용을 서술한다.`).join(' ')

// ── 1. 수정 계획을 세운다 (모든 변형이 이 계획을 그대로 쓴다) ────────────

const original = new Uint8Array(readFileSync(join(inputDir, SOURCE)))
const loaded = await loadHwpxBytes(original, SOURCE)
const model = loaded.model
const paragraphs = collectParagraphs(model)

/** 문단 id → 그 문단을 담고 있는 표 셀(가장 안쪽). */
const cellOf = new Map<string, TableCell>()
/** 표의 한 행에 속한 셀들. 행 높이는 같이 움직인다. */
const rowOf = new Map<string, TableCell[]>()
const indexCells = (blocks: readonly Block[]): void => {
  for (const block of blocks) {
    if (block.kind !== 'table') continue
    for (const row of block.rows) {
      for (const cell of row) {
        for (const inner of cell.blocks) {
          if (inner.kind === 'paragraph') {
            cellOf.set(inner.id, cell)
            rowOf.set(inner.id, row)
          }
        }
        indexCells(cell.blocks)
      }
    }
  }
}
for (const section of model.sections) indexCells(section.blocks)

const all = model.sections.flatMap((section) => section.paragraphs)
const byId = new Map(all.map((p) => [p.id, p]))
const inTable = (id: string): boolean => cellOf.has(id)

const pick = <T,>(list: readonly T[], n: number): T[] => list.slice(0, n)

// (1) 짧은 값이 든 표 셀 → 긴 값
const shortCells = paragraphs.filter(
  (p) => inTable(p.id) && p.text.trim().length > 1 && p.text.length <= 14,
)
// (2) 비어 있는 표 셀 → 여러 줄 분량
const blankCells = paragraphs.filter((p) => inTable(p.id) && p.text.length === 0)
// (3) 이미 긴 본문 문단 → 더 길게
const longBody = paragraphs.filter((p) => !inTable(p.id) && p.text.trim().length > 40)
// (4) 그림과 같은 구역에 있는 문단
const imageNeighbours = (() => {
  const out: string[] = []
  const scan = (blocks: readonly Block[]): void => {
    blocks.forEach((block, i) => {
      if (block.kind === 'image') {
        for (const near of [blocks[i - 1], blocks[i + 1]]) {
          if (near?.kind === 'paragraph' && near.text.trim().length > 6) out.push(near.id)
        }
        return
      }
      if (block.kind === 'table') {
        for (const row of block.rows) for (const cell of row) scan(cell.blocks)
      }
    })
  }
  for (const section of model.sections) scan(section.blocks)
  return out
})()
// (5) 문서 뒤쪽 — 여기서 길어지면 페이지가 밀린다
const tail = paragraphs.slice(Math.floor(paragraphs.length * 0.75))
  .filter((p) => p.text.trim().length > 20)

const operations: EditOperation[] = []
const seen = new Set<string>()
const add = (id: string, newText: string, reason: string): void => {
  if (seen.has(id) || !byId.has(id)) return
  seen.add(id)
  operations.push({ type: 'replace_text', paragraphId: id, oldText: byId.get(id)!.text, newText, reason })
}

for (const p of pick(shortCells, 3)) add(p.id, `${p.text} — ${LONG(3, '확장')}`, '짧은 값 → 긴 값(표 셀)')
for (const p of pick(blankCells, 3)) add(p.id, LONG(4, '빈칸'), '빈 셀 → 여러 줄')
for (const p of pick(longBody, 2)) add(p.id, `${p.text} ${LONG(6, '본문확장')}`, '긴 문단 확장')
for (const id of pick(imageNeighbours, 2)) add(id, `${byId.get(id)?.text ?? ''} ${LONG(4, '그림옆')}`, '그림 근처 문단')
for (const p of pick(tail, 2)) add(p.id, `${p.text} ${LONG(8, '페이지경계')}`, '뒤쪽 문단 — 페이지 밀림')

// 같은 표의 여러 행을 한꺼번에
const multiRow = shortCells.filter((p) => !seen.has(p.id)).slice(0, 4)
for (const p of multiRow) add(p.id, `${p.text} — ${LONG(2, '여러행')}`, '표 여러 행 동시')

console.log(`문서   ${SOURCE}`)
console.log(`수정   ${operations.length}곳`)
for (const op of operations) {
  console.log(`  ${op.paragraphId.padEnd(9)} ${String(op.reason).padEnd(20)} ${op.oldText.length}자 → ${op.newText.length}자`)
}

// ── 2. 텍스트만 고친 기준 파일 ────────────────────────────────────────

const edited = HwpxDocument.fromLoadResult(await loadHwpxBytes(original, SOURCE))
const applied = edited.apply({ operations, summary: '레이아웃 실험' })
const editedBytes = await edited.toBytes({ layout: 'off' })
const editedIds = applied.map((c) => c.paragraphId)

// ── 3. 변형들 ────────────────────────────────────────────────────────

type Mode = {
  file: string
  what: string
  /** section XML 을 어떻게 손볼 것인가. 반환값이 없으면 그대로 둔다. */
  transform?: (xml: Uint8Array, sectionIndex: number, name: string) => Uint8Array
}

/** 문단 캐시 구간을 모은다. onlyEdited 면 고친 문단과 그 조상만. */
const segSpans = (xml: Uint8Array, index: number, name: string, onlyEdited: boolean): ByteSpan[] => {
  const section = parseSection(xml, index, name)
  const map = new Map(section.paragraphs.map((p) => [p.id, p]))
  const wanted = new Set<string>()
  if (onlyEdited) {
    for (const id of editedIds) {
      let cursor = map.get(id)
      while (cursor && !wanted.has(cursor.id)) {
        wanted.add(cursor.id)
        cursor = cursor.parentId ? map.get(cursor.parentId) : undefined
      }
    }
  } else {
    for (const p of section.paragraphs) wanted.add(p.id)
  }
  return section.paragraphs
    .filter((p) => p.lineSegSpan && wanted.has(p.id))
    .map((p) => p.lineSegSpan!)
    .sort((a, b) => a.start - b.start)
}

const enc = new TextEncoder()
const strip = (onlyEdited: boolean, replacement = '') =>
  (xml: Uint8Array, index: number, name: string): Uint8Array =>
    spliceBytes(
      xml,
      segSpans(xml, index, name, onlyEdited).map((s) => ({ ...s, bytes: enc.encode(replacement) })),
    )

/** 캐시를 전부 지우고, 고친 셀이 든 행의 높이를 배율만큼 바꾼다. */
const stripAndResize = (factor: number) =>
  (xml: Uint8Array, index: number, name: string): Uint8Array => {
    const section = parseSection(xml, index, name)
    const map = new Map(section.paragraphs.map((p) => [p.id, p]))
    const targetRows: TableCell[][] = []
    const walk = (blocks: readonly Block[]): void => {
      for (const block of blocks) {
        if (block.kind !== 'table') continue
        for (const row of block.rows) {
          const hit = row.some((cell) =>
            cell.blocks.some((b) => b.kind === 'paragraph' && editedIds.includes(b.id)),
          )
          if (hit) targetRows.push(row)
          for (const cell of row) walk(cell.blocks)
        }
      }
    }
    walk(section.blocks)

    const edits = segSpans(xml, index, name, false).map((s) => ({ ...s, bytes: new Uint8Array(0) }))
    for (const row of targetRows) {
      // 한 행의 셀 높이는 함께 움직여야 한다. 가장 큰 값을 기준으로 배율을 건다.
      const base = Math.max(...row.map((cell) => cell.height ?? 0))
      const next = Math.max(280, Math.round(base * factor))
      for (const cell of row) {
        if (!cell.sizeSpan || cell.width === undefined) continue
        edits.push({
          start: cell.sizeSpan.start,
          end: cell.sizeSpan.end,
          bytes: enc.encode(`<hp:cellSz width="${cell.width}" height="${next}"/>`),
        })
      }
    }
    void map
    return spliceBytes(xml, edits)
  }

const MODES: Mode[] = [
  { file: 'A-현재방식(캐시 그대로)', what: '텍스트만 교체. 지금 서비스가 내보내는 것과 같다.' },
  { file: 'B-고친문단만 캐시삭제', what: '고친 문단과 그것을 감싼 바깥 문단의 linesegarray만 삭제.', transform: strip(true) },
  { file: 'C-문서전체 캐시삭제', what: '문서의 모든 linesegarray 삭제. 뒤 내용과 페이지까지 다시 흐르게.', transform: strip(false) },
  { file: 'D-문서전체 캐시를 빈요소로', what: '삭제 대신 <hp:linesegarray/> 로 교체. 스키마 경고가 나는지 본다.', transform: strip(false, '<hp:linesegarray/>') },
  { file: 'E-전체삭제+행높이 축소', what: 'C에 더해 고친 행의 셀 높이를 절반으로. 한글이 늘려 주는가?', transform: stripAndResize(0.5) },
  { file: 'F-전체삭제+행높이 확대', what: 'C에 더해 고친 행의 셀 높이를 3배로. 한글이 줄여 주는가?', transform: stripAndResize(3) },
]

console.log('\n=== 만든 파일 ===')
for (const mode of MODES) {
  const archive = ZipArchive.open(editedBytes)
  const sections = new Map<string, Uint8Array>()
  if (mode.transform) {
    for (const section of model.sections) {
      const xml = await archive.read(section.name)
      sections.set(section.name, mode.transform(xml, section.index, section.name))
    }
  }
  const bytes = await repackage(archive, sections)

  // 안전 확인: 다시 열리고 글자가 그대로인가.
  const again = await loadHwpxBytes(bytes, SOURCE)
  const before = model.sections.flatMap((s) => s.paragraphs.map((p) => p.text))
  const now = again.model.sections.flatMap((s) => s.paragraphs.map((p) => p.text))
  const editedTexts = new Map(applied.map((c) => [c.paragraphId, c.newText]))
  const textOk =
    now.length === before.length &&
    again.model.sections
      .flatMap((s) => s.paragraphs)
      .every((p) => (editedTexts.has(p.id) ? p.text === editedTexts.get(p.id) : true))

  const segsLeft = (new TextDecoder().decode(await ZipArchive.open(bytes).read('Contents/section0.xml'))
    .match(/<hp:lineseg\b/g) ?? []).length

  const target = join(outputDir, `${mode.file}.hwpx`)
  writeFileSync(target, bytes)
  console.log(
    `  ${textOk ? '✅' : '❌'} ${mode.file.padEnd(26)} ${(bytes.byteLength / 1024).toFixed(0).padStart(5)}KB  남은 lineseg ${String(segsLeft).padStart(4)}  ${mode.what}`,
  )
}

console.log(`\n→ ${outputDir}`)
console.log('\n한글에서 A부터 F까지 열어 아래를 봐 주세요.')
console.log('  · 파일 복구/오류 경고가 뜨는가 (뜨면 그 방식은 탈락)')
console.log('  · 긴 글자가 셀 밖으로 넘치는가')
console.log('  · 표 행이 내용에 맞게 늘어나는가')
console.log('  · 뒤 내용과 페이지가 자연스럽게 밀리는가')
console.log('  · 글꼴/표/그림이 그대로인가')
