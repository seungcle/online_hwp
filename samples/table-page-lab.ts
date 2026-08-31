/**
 * 표가 페이지를 넘길 때 무엇이 잘리는가.
 *
 *   npm run layout:table
 *
 * 1차 실험(`layout-lab.ts`)에서 줄 배치 캐시를 걷어내면 셀 안 글자는 정상으로
 * 흐른다는 것까지 확인했다. 남은 증상은 하나다 — **표가 한 페이지를 넘길 만큼
 * 길어지면 다음 쪽으로 이어지지 않고 잘린다.**
 *
 * 실측으로 좁혀진 용의자는 둘이다.
 *
 *  1. `hp:sz height` — 표 개체의 상자 높이. 셀 높이처럼 한글이 계산해 둔 값이다.
 *     실제 업무 문서 4개에서 **어떤 표도 한 페이지를 넘지 않았다**
 *     (최대 67594 < 쓸 수 있는 높이 75684). 양식이 그렇게 설계돼 있어서,
 *     우리가 늘린 표는 원본에 없던 상황이다.
 *  2. `hp:pos treatAsChar` — 0이면 글자처럼 취급하지 않는 **개체**다. 개체는
 *     본문 흐름 밖에 놓이므로 페이지를 넘겨 나뉘지 않는다. 문제의 표가 0이다.
 *
 * 두 변인을 2×2로 갈라 네 벌을 만든다. 어느 조합에서 표가 다음 쪽으로
 * 이어지는지 보면 무엇을 고쳐야 하는지 정해진다.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadHwpxBytes } from '../frontend/src/hwpx/package'
import { HwpxDocument } from '../frontend/src/hwpx/session'
import { parseSection, type Block, type Table } from '../frontend/src/hwpx/document'
import { spliceBytes, type EditOperation } from '../frontend/src/hwpx/patch'
import { ZipArchive } from '../frontend/src/hwpx/zip'
import { repackage } from '../frontend/src/hwpx/zip-writer'
import { collectParagraphs } from '../frontend/src/ai/client'

const inputDir = resolve(process.env['HWPX_SAMPLE_DIR'] ?? 'samples/local')
const outputDir = resolve('samples/output/표분할')
const SOURCE =
  process.env['HWPX_SAMPLE_FILE'] ?? '00.과정개발보고서_보끄레_고객경험(CX) 대시보드 자동화.hwpx'

if (!existsSync(join(inputDir, SOURCE))) {
  console.error(`${join(inputDir, SOURCE)} 가 없습니다.`)
  process.exit(1)
}
mkdirSync(outputDir, { recursive: true })

const original = new Uint8Array(readFileSync(join(inputDir, SOURCE)))
const loaded = await loadHwpxBytes(original, SOURCE)
const model = loaded.model

/** 표를 문서 순서대로 모은다. */
const tables: Table[] = []
const gather = (blocks: readonly Block[]): void => {
  for (const block of blocks) {
    if (block.kind !== 'table') continue
    tables.push(block)
    for (const row of block.rows) for (const cell of row) gather(cell.blocks)
  }
}
for (const section of model.sections) gather(section.blocks)

/** 가장 큰 표를 고른다. 한 페이지에 꽉 차 있어 조금만 늘려도 넘친다. */
const target = [...tables].sort((a, b) => (b.boxHeight ?? 0) - (a.boxHeight ?? 0))[0]!
const cellParagraphIds = target.rows.flatMap((row) =>
  row.flatMap((cell) => cell.blocks.filter((b) => b.kind === 'paragraph').map((b) => b.id)),
)

console.log(`문서   ${SOURCE}`)
const mergedCells = target.rows.flat().filter((c) => c.rowSpan > 1).length
console.log(`대상 표 ${target.id} — ${target.rows.length}행, 상자 높이 ${target.boxHeight}, ` +
  `treatAsChar=${target.treatAsChar ? 1 : 0}, pageBreak=${target.pageBreak}, 세로병합 ${mergedCells}칸`)
if (mergedCells > 0) {
  console.log('   ⚠ 세로로 병합된 칸이 있다. 한글은 병합 칸을 페이지 경계에서 쪼개지 못한다.')
}
console.log(`쓸 수 있는 페이지 높이 ≈ 75684 — 이 표는 이미 ${Math.round((target.boxHeight ?? 0) / 75684 * 100)}% 를 쓰고 있다.`)

// ── 이 표를 확실히 한 페이지 넘게 만든다 ─────────────────────────────

const LONG = '이 칸의 내용을 충분히 길게 늘려 여러 줄이 되도록 서술한 문장이다. '.repeat(3)
const paragraphs = collectParagraphs(model)
const byId = new Map(paragraphs.map((p) => [p.id, p]))
const editable = cellParagraphIds
  .map((id) => byId.get(id))
  .filter((p): p is NonNullable<typeof p> => p !== undefined)
  .slice(0, 12)

const operations: EditOperation[] = editable.map((p) => ({
  type: 'replace_text',
  paragraphId: p.id,
  oldText: p.text,
  newText: `${p.text} ${LONG}`.trim(),
}))
console.log(`수정   이 표 안 ${operations.length}칸을 길게 늘린다 (칸마다 약 ${LONG.length}자 추가)\n`)

const edited = HwpxDocument.fromLoadResult(await loadHwpxBytes(original, SOURCE))
edited.apply({ operations, summary: '표 분할 실험' })
// 줄 배치 캐시 정리 + 넘치는 표 자동 전환까지 **실제 서비스 경로 그대로** 거친다.
const base = await edited.toBytes()
const report = edited.layoutReport!
console.log(`정규화 캐시 ${report.clearedParagraphs}문단 정리 · ` +
  `흐르게 바꾼 표 ${report.tablesMadeFlowable.length}개 · 구조가 막는 표 ${report.tablesStillStuck.length}개`)
for (const stuck of report.tablesStillStuck) console.log(`   막힘: ${stuck.id} — ${stuck.reason}`)


// ── 2×2 ────────────────────────────────────────────────────────────

const enc = new TextEncoder()

/** 편집한 표를 다시 찾아 hp:sz / hp:pos 를 손본다. */
const transform = (bumpBox: boolean, inline: boolean) =>
  (xml: Uint8Array, index: number, name: string): Uint8Array => {
    const section = parseSection(xml, index, name)
    const found: Table[] = []
    const walk = (blocks: readonly Block[]): void => {
      for (const b of blocks) {
        if (b.kind !== 'table') continue
        const hit = b.rows.some((row) =>
          row.some((cell) =>
            cell.blocks.some((x) => x.kind === 'paragraph' && cellParagraphIds.includes(x.id)),
          ),
        )
        if (hit) found.push(b)
        for (const row of b.rows) for (const cell of row) walk(cell.blocks)
      }
    }
    walk(section.blocks)

    const edits: { start: number; end: number; bytes: Uint8Array }[] = []
    for (const table of found) {
      if (bumpBox && table.boxSpan && table.boxWidth !== undefined) {
        // 상자를 넉넉히 키운다. 정확한 값을 계산하는 것이 목적이 아니라
        // "상자가 잘림의 원인인가"를 가리는 것이 목적이다.
        const next = Math.round((table.boxHeight ?? 0) * 2)
        edits.push({
          start: table.boxSpan.start,
          end: table.boxSpan.end,
          bytes: enc.encode(
            `<hp:sz width="${table.boxWidth}" widthRelTo="ABSOLUTE" height="${next}" heightRelTo="ABSOLUTE" protect="0"/>`,
          ),
        })
      }
      if (inline && table.pageBreak !== 'CELL') {
        // 셀 단위 나눔이 아니면 글자처럼 취급해도 페이지에서 안 나뉜다.
        // (표 여는 태그의 속성이라 여기서는 다루지 않는다 — 아래 K 변형에서 함께 본다.)
      }
      if (inline && table.posSpan) {
        const raw = new TextDecoder().decode(xml.subarray(table.posSpan.start, table.posSpan.end))
        edits.push({
          start: table.posSpan.start,
          end: table.posSpan.end,
          bytes: enc.encode(raw.replace(/treatAsChar="0"/, 'treatAsChar="1"')),
        })
      }
    }
    return edits.length ? spliceBytes(xml, edits.sort((a, b) => a.start - b.start)) : xml
  }

const MODES = [
  { file: 'K-지금 서비스가 내보내는 것', box: false, inline: false, what: '캐시 정리 + 넘칠 때만 자동으로 흐르게. 실제 동작.' },
  { file: 'L-상자도 키움', box: true, inline: false, what: 'K에 더해 hp:sz height ×2. 상자가 더 필요한가?' },
]

console.log('=== 만든 파일 ===')
for (const mode of MODES) {
  const archive = ZipArchive.open(base)
  const sections = new Map<string, Uint8Array>()
  if (mode.box || mode.inline) {
    for (const section of model.sections) {
      const xml = await archive.read(section.name)
      sections.set(section.name, transform(mode.box, mode.inline)(xml, section.index, section.name))
    }
  }
  const bytes = await repackage(archive, sections)

  const again = await loadHwpxBytes(bytes, SOURCE)
  const ok =
    again.model.stats.paragraphCount === model.stats.paragraphCount &&
    again.model.stats.tableCount === model.stats.tableCount &&
    again.model.stats.imageCount === model.stats.imageCount

  writeFileSync(join(outputDir, `${mode.file}.hwpx`), bytes)
  console.log(`  ${ok ? '✅' : '❌'} ${mode.file.padEnd(16)} ${(bytes.byteLength / 1024).toFixed(0).padStart(5)}KB  ${mode.what}`)
}

console.log(`\n→ ${outputDir}`)
console.log('\n한글에서 K, L 을 열어 대상 표를 봐 주세요.')
console.log('  · 표가 다음 쪽으로 이어지는가, 아니면 잘리는가')
console.log('  · 이어진다면 표 머리행이 반복되는가')
console.log('  · 표 위치가 원래 자리에서 밀리지 않았는가')
console.log('  · 뒤 내용이 겹치지 않는가')
