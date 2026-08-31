/**
 * 내려받기 직전의 레이아웃 정규화.
 *
 * 문제는 이렇다. 한글은 문서를 저장할 때 **줄 배치 결과를 캐시로 함께 적어
 * 둔다.** 문단마다 `hp:linesegarray`가 붙어 있고, 그 안에 줄 하나당
 * `hp:lineseg`가 하나씩, 그 줄이 몇 번째 글자에서 시작하는지(`textpos`)와
 * 세로 위치(`vertpos`)까지 들어 있다. 표 셀의 높이(`hp:cellSz`)도 그렇게
 * 계산된 결과다 — 실측하면 셀 높이가 줄 수를 그대로 따라간다.
 *
 *     5줄 × (vertsize 1000 + spacing 300) + 안쪽 여백 ≈ cellSz height 6484
 *
 * 우리는 바이트 구간만 갈아끼우므로 이 캐시는 손대지 않은 채 남는다. 짧은
 * 글자를 짧은 글자로 바꿀 때는 티가 안 나지만, 긴 글자를 넣으면 한글이 **낡은
 * 캐시를 그대로 믿어** 글자가 셀 밖으로 넘치거나 뒤 내용과 겹친다.
 *
 * 해결은 우리가 조판을 다시 하는 것이 아니라 **한글이 다시 하게 만드는 것**이다.
 * `hp:linesegarray`는 선택 요소이고, 없으면 한글이 파일을 열면서 줄 배치를
 * 처음부터 계산한다. 여러 HWPX 도구가 같은 결론에 도달해 있다 —
 * "문단 안의 run을 하나라도 고치면 그 문단의 linesegarray를 지운다."
 *
 * 그래서 여기서 하는 일은 **지우는 것뿐이다.** 새 값을 지어내지 않는다.
 * 추측한 높이를 적어 넣으면 그게 또 하나의 틀린 캐시가 된다.
 */

import {
  usableHeight,
  type Block,
  type ByteSpan,
  type DocumentModel,
  type SectionModel,
  type Table,
  type TableCell,
} from './document'
import { spliceBytes } from './patch'

/** 어느 문단의 캐시를 버릴 것인가. */
export type LayoutScope =
  /** 고친 문단과 그것을 감싼 바깥 문단만. 건드리는 바이트가 가장 적다. */
  | 'edited'
  /** 문서 전체. 한 곳이 길어지면 뒤 내용과 페이지가 전부 밀리므로 이쪽이 안전하다. */
  | 'all'

export interface LayoutReport {
  /** 캐시를 버린 문단 수. */
  readonly clearedParagraphs: number
  /** 실제로 바뀐 section 이름. */
  readonly sections: readonly string[]
  /** 지운 바이트 수. */
  readonly removedBytes: number
  /** 페이지를 넘칠 것 같아 흐르도록 바꾼 표. */
  readonly tablesMadeFlowable: readonly string[]
  /** 넘칠 것 같지만 구조 때문에 나눌 수 없는 표. 사용자에게 알릴 거리다. */
  readonly tablesStillStuck: readonly { id: string; reason: string }[]
}

/**
 * 이 표가 페이지 경계에서 나뉠 수 있는가. 나뉠 수 없다면 그 이유.
 *
 * 실측(문서 하나에 표 28개): 조건 없이 나뉘는 표는 12개뿐이었다.
 * 나머지는 개체 취급 10, 세로 병합 7, 표 단위 넘김 3, 중첩표 1이 막고 있었다.
 * 앞의 둘은 속성이라 우리가 바꿀 수 있고, 뒤의 둘은 표 구조라 손대지 않는다.
 */
export interface TableSplitability {
  readonly table: Table
  /** 우리가 속성을 바꿔서 풀 수 있는 걸림돌. */
  readonly fixable: readonly ('개체 취급' | '표 단위 넘김')[]
  /** 표 구조라서 우리가 풀 수 없는 걸림돌. */
  readonly blocked: readonly string[]
}

export function analyzeTable(table: Table, nested: boolean): TableSplitability {
  const fixable: ('개체 취급' | '표 단위 넘김')[] = []
  const blocked: string[] = []
  if (table.treatAsChar === false) fixable.push('개체 취급')
  if (table.pageBreak === 'TABLE') fixable.push('표 단위 넘김')
  if (table.pageBreak === 'NONE') blocked.push('나눔 없음으로 설정된 표')
  if (nested) blocked.push('다른 표 안에 들어 있는 표')
  const merged = table.rows.flat().filter((cell) => cell.rowSpan > 1).length
  if (merged > 0) blocked.push(`세로로 병합된 칸 ${merged}개`)
  return { table, fixable, blocked }
}

/** 문서의 모든 표를 중첩 여부와 함께 훑는다. */
export function walkTables(
  model: DocumentModel,
  visit: (table: Table, nested: boolean, section: SectionModel) => void,
): void {
  const go = (blocks: readonly Block[], nested: boolean, section: SectionModel): void => {
    for (const block of blocks) {
      if (block.kind !== 'table') continue
      visit(block, nested, section)
      for (const row of block.rows) for (const cell of row) go(cell.blocks, true, section)
    }
  }
  for (const section of model.sections) go(section.blocks, false, section)
}

export interface NormalizeResult {
  readonly sections: Map<string, Uint8Array>
  readonly report: LayoutReport
}

/**
 * 글이 길어져 이 표가 얼마나 커질지 어림한다.
 *
 * **새 높이를 문서에 적으려는 것이 아니다.** "페이지를 넘칠 것 같은가"라는
 * 예/아니오 하나를 정하려고 재는 것뿐이다. 그래서 정확할 필요는 없고,
 * 넘치는 쪽으로 틀리는 편이 안전하다.
 *
 * 폰트 메트릭을 새로 만들지 않는다. 대신 **문서가 이미 답해 놓은 값**을 쓴다 —
 * 각 칸이 예전에 몇 글자로 몇 줄을 썼는지가 `lineCount`에 남아 있으므로,
 * 거기서 "한 줄에 몇 글자"가 나온다.
 */
export interface TextChange {
  /** 고치기 전 글자. "한 줄에 몇 글자"를 여기서 구한다. */
  readonly from: string
  readonly to: string
}

export function estimateTableHeight(
  table: Table,
  changeOf: (paragraphId: string) => TextChange | undefined,
): number {
  let total = 0
  for (const row of table.rows) {
    const plain = row.filter((cell) => cell.rowSpan === 1)
    const cells = plain.length > 0 ? plain : row
    let rowHeight = 0
    for (const cell of cells) {
      rowHeight = Math.max(rowHeight, estimateCellHeight(cell, changeOf))
    }
    total += rowHeight
  }
  return total
}

function estimateCellHeight(
  cell: TableCell,
  changeOf: (paragraphId: string) => TextChange | undefined,
): number {
  const height = cell.height ?? 0
  const paragraphs = cell.blocks.filter((b): b is Extract<Block, { kind: 'paragraph' }> =>
    b.kind === 'paragraph',
  )
  const oldLines = paragraphs.reduce((sum, p) => sum + (p.lineCount ?? 1), 0)
  if (oldLines === 0) return height

  let newLines = 0
  for (const paragraph of paragraphs) {
    const lines = paragraph.lineCount ?? 1
    const change = changeOf(paragraph.id)
    if (change === undefined) {
      newLines += lines
      continue
    }
    // 이 칸이 한 줄에 몇 글자를 담았는지. **고치기 전** 글자로 재야 한다.
    // 모델은 이미 새 글자로 갱신돼 있어서 지금 텍스트로 재면 언제나 그대로다.
    // 빈 칸이었으면 잴 것이 없으므로 보수적으로 좁게 본다.
    const perLine = change.from.length > 0 ? change.from.length / lines : 12
    newLines += Math.max(1, Math.ceil(change.to.length / Math.max(1, perLine)))
  }
  const lineHeight = height / oldLines
  return Math.max(height, Math.round(lineHeight * newLines))
}

/**
 * 낡은 줄 배치 캐시를 걷어낸다.
 *
 * 반환된 section 바이트는 `hp:linesegarray` 요소가 통째로 빠진 것 말고는
 * 원본과 같다. 다른 요소는 물론이고 속성 하나, 공백 하나 건드리지 않는다.
 */
export function normalizeLayout(
  model: DocumentModel,
  sectionBytes: ReadonlyMap<string, Uint8Array>,
  editedParagraphIds: readonly string[],
  scope: LayoutScope = 'all',
  changeOf: (paragraphId: string) => TextChange | undefined = () => undefined,
): NormalizeResult {
  const sections = new Map<string, Uint8Array>()
  let clearedParagraphs = 0
  let removedBytes = 0
  const madeFlowable: string[] = []
  const stillStuck: { id: string; reason: string }[] = []
  const encoder = new TextEncoder()

  // 어떤 표가 페이지를 넘칠 것 같은가. 넘칠 때만 손댄다 — 멀쩡한 표의 속성을
  // 건드릴 이유가 없다.
  const tableEdits = new Map<string, { start: number; end: number; bytes: Uint8Array<ArrayBuffer> }[]>()
  const edited = new Set(editedParagraphIds)
  walkTables(model, (table, nested, section) => {
    const touched = table.rows
      .flat()
      .some((cell) => cell.blocks.some((b) => b.kind === 'paragraph' && edited.has(b.id)))
    if (!touched) return

    const limit = usableHeight(section.page)
    if (limit <= 0) return
    if (estimateTableHeight(table, changeOf) <= limit) return

    const verdict = analyzeTable(table, nested)
    if (verdict.blocked.length > 0) {
      stillStuck.push({ id: table.id, reason: verdict.blocked.join(', ') })
      // 구조가 막고 있어도 속성은 풀어 둔다. 나뉘는 데까지는 나뉜다.
    }
    if (verdict.fixable.length === 0) return

    const list = tableEdits.get(section.name) ?? []
    if (table.treatAsChar === false && table.posSpan) {
      const raw = decodeSpan(sectionBytes.get(section.name), table.posSpan)
      if (raw) {
        list.push({
          ...table.posSpan,
          bytes: encoder.encode(raw.replace(/treatAsChar="0"/, 'treatAsChar="1"')),
        })
      }
    }
    if (table.pageBreak === 'TABLE' && table.headSpan) {
      const raw = decodeSpan(sectionBytes.get(section.name), table.headSpan)
      if (raw) {
        list.push({
          ...table.headSpan,
          bytes: encoder.encode(raw.replace(/pageBreak="TABLE"/, 'pageBreak="CELL"')),
        })
      }
    }
    if (list.length > 0) {
      tableEdits.set(section.name, list)
      madeFlowable.push(table.id)
    }
  })

  for (const section of model.sections) {
    const original = sectionBytes.get(section.name)
    if (!original) continue

    const spans = spansToClear(section, editedParagraphIds, scope)
    const edits: { start: number; end: number; bytes: Uint8Array<ArrayBuffer> }[] = spans.map(
      (span) => ({ start: span.start, end: span.end, bytes: new Uint8Array(0) }),
    )
    edits.push(...(tableEdits.get(section.name) ?? []))
    if (edits.length === 0) continue

    sections.set(section.name, spliceBytes(original, edits.sort((a, b) => a.start - b.start)))
    clearedParagraphs += spans.length
    removedBytes += spans.reduce((sum, span) => sum + (span.end - span.start), 0)
  }

  return {
    sections,
    report: {
      clearedParagraphs,
      sections: [...sections.keys()],
      removedBytes,
      tablesMadeFlowable: madeFlowable,
      tablesStillStuck: stillStuck,
    },
  }
}

function decodeSpan(bytes: Uint8Array | undefined, span: ByteSpan): string | undefined {
  if (!bytes) return undefined
  return new TextDecoder().decode(bytes.subarray(span.start, span.end))
}

function spansToClear(
  section: SectionModel,
  editedParagraphIds: readonly string[],
  scope: LayoutScope,
): ByteSpan[] {
  const wanted = new Set<string>()
  if (scope === 'all') {
    for (const paragraph of section.paragraphs) wanted.add(paragraph.id)
  } else {
    const byId = new Map(section.paragraphs.map((paragraph) => [paragraph.id, paragraph]))
    for (const id of editedParagraphIds) {
      // 표 안 문단이 길어지면 표를 감싼 바깥 문단의 줄 배치도 함께 낡는다.
      // 조상을 끝까지 따라 올라간다.
      let cursor = byId.get(id)
      while (cursor && !wanted.has(cursor.id)) {
        wanted.add(cursor.id)
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
      }
    }
  }

  const spans: ByteSpan[] = []
  for (const paragraph of section.paragraphs) {
    if (paragraph.lineSegSpan && wanted.has(paragraph.id)) spans.push(paragraph.lineSegSpan)
  }
  // 구간이 겹치면 spliceBytes가 막아 준다. linesegarray는 서로 중첩되지 않는다.
  return spans.sort((a, b) => a.start - b.start)
}
