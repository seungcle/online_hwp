/**
 * 줄 배치 캐시 정리.
 *
 * 한글은 저장할 때 문단마다 `hp:linesegarray`에 줄 배치 결과를 적어 둔다.
 * 텍스트를 고치면 그 값이 낡는데, 한글은 낡은 값을 그대로 믿어 글자가 셀 밖으로
 * 넘친다. 우리가 조판을 다시 하는 대신 캐시를 걷어내 한글이 다시 계산하게 한다.
 *
 * 여기서 지키는 것은 두 가지다.
 *  1. 고치지 않은 문서는 **원본과 바이트 단위로 같아야 한다.**
 *  2. 캐시를 걷어내도 글자·문단·표·그림은 하나도 변하지 않아야 한다.
 */

import { describe, expect, it } from 'vitest'
import { BLANK_FORM_XML, buildHwpx, pageTableXml, SECTION_XML } from './helpers/hwpx-fixture'
import { loadHwpxBytes } from '../frontend/src/hwpx/package'
import { HwpxDocument } from '../frontend/src/hwpx/session'
import { normalizeLayout } from '../frontend/src/hwpx/layout'
import { usableHeight } from '../frontend/src/hwpx/document'
import { collectParagraphs } from '../frontend/src/ai/client'
import { ZipArchive } from '../frontend/src/hwpx/zip'
import type { EditPlan } from '../frontend/src/hwpx/patch'

const open = async (sections?: string[]) => {
  const bytes = await buildHwpx(sections ? { sections } : {})
  const loaded = await loadHwpxBytes(bytes, 'sample.hwpx')
  return { bytes, loaded, document: HwpxDocument.fromLoadResult(loaded) }
}

const sectionText = async (bytes: Uint8Array): Promise<string> =>
  new TextDecoder().decode(await ZipArchive.open(bytes).read('Contents/section0.xml'))

const countSegs = (xml: string): number => (xml.match(/<hp:lineseg\b/g) ?? []).length

const identical = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((v, i) => v === b[i])

describe('linesegarray 구간을 찾아낸다', () => {
  it('문단마다 캐시 구간을 잡는다', async () => {
    const { loaded } = await open()
    const paragraphs = loaded.model.sections[0]!.paragraphs
    expect(paragraphs.length).toBeGreaterThan(0)
    expect(paragraphs.every((p) => p.lineSegSpan !== undefined)).toBe(true)
    for (const p of paragraphs) {
      expect(p.lineSegSpan!.end).toBeGreaterThan(p.lineSegSpan!.start)
    }
  })

  it('표 안 문단은 바깥 문단을 부모로 안다', async () => {
    const { loaded } = await open()
    const paragraphs = loaded.model.sections[0]!.paragraphs
    const nested = paragraphs.filter((p) => p.parentId !== undefined)
    expect(nested.length).toBeGreaterThan(0)
    // 부모도 같은 section 안에 실재해야 한다.
    const ids = new Set(paragraphs.map((p) => p.id))
    expect(nested.every((p) => ids.has(p.parentId!))).toBe(true)
  })
})

describe('normalizeLayout', () => {
  it('문서 전체 캐시를 걷어내되 글자는 그대로 둔다', async () => {
    const { loaded } = await open()
    const before = new Map([['Contents/section0.xml', loaded.sectionBytes.get('Contents/section0.xml')!]])
    const { sections, report } = normalizeLayout(loaded.model, before, [], 'all')

    const xml = new TextDecoder().decode(sections.get('Contents/section0.xml')!)
    expect(countSegs(xml)).toBe(0)
    expect(xml).not.toContain('<hp:linesegarray')
    expect(report.clearedParagraphs).toBe(loaded.model.sections[0]!.paragraphs.length)
    expect(report.removedBytes).toBeGreaterThan(0)

    // 글자·표·그림은 손대지 않는다.
    expect(xml).toContain('2025년 사업 제안서')
    expect(xml).toContain('<hp:cellSz')
    expect(xml).toContain('binaryItemIDRef="image1"')
  })

  it('edited 범위는 고친 문단과 그 조상만 지운다', async () => {
    const { loaded } = await open()
    const paragraphs = loaded.model.sections[0]!.paragraphs
    const nested = paragraphs.find((p) => p.parentId !== undefined)!
    const before = new Map([['Contents/section0.xml', loaded.sectionBytes.get('Contents/section0.xml')!]])

    const { report } = normalizeLayout(loaded.model, before, [nested.id], 'edited')
    // 자기 자신 + 감싼 바깥 문단. 문서 전체보다 훨씬 적어야 한다.
    expect(report.clearedParagraphs).toBeGreaterThanOrEqual(2)
    expect(report.clearedParagraphs).toBeLessThan(paragraphs.length)
  })

  it('고친 문단이 없으면 아무것도 지우지 않는다', async () => {
    const { loaded } = await open()
    const before = new Map([['Contents/section0.xml', loaded.sectionBytes.get('Contents/section0.xml')!]])
    const { sections, report } = normalizeLayout(loaded.model, before, [], 'edited')
    expect(sections.size).toBe(0)
    expect(report.clearedParagraphs).toBe(0)
  })
})

describe('내려받기', () => {
  it('한 글자도 고치지 않았으면 원본과 바이트가 같다', async () => {
    const { bytes, document } = await open()
    expect(identical(await document.toBytes(), bytes)).toBe(true)
    expect(document.layoutReport).toBeUndefined()
  })

  it('고치면 캐시가 사라지고 글자는 살아 있다', async () => {
    const { document } = await open()
    const target = document.model.sections[0]!.paragraphs.find((p) => p.text.includes('2025년'))!
    const plan: EditPlan = {
      operations: [
        {
          type: 'replace_text',
          paragraphId: target.id,
          oldText: target.text,
          newText: '아주 긴 문장으로 바꾼다. '.repeat(20),
        },
      ],
    }
    document.apply(plan)
    const out = await document.toBytes()

    const xml = await sectionText(out)
    expect(countSegs(xml)).toBe(0)
    expect(document.layoutReport!.clearedParagraphs).toBeGreaterThan(0)

    const again = await loadHwpxBytes(out, 'again.hwpx')
    const texts = again.model.sections.flatMap((s) => s.paragraphs.map((p) => p.text))
    expect(texts.some((t) => t.startsWith('아주 긴 문장으로'))).toBe(true)
    // 문단·표·그림 수는 그대로.
    expect(again.model.stats.paragraphCount).toBe(document.model.stats.paragraphCount)
    expect(again.model.stats.tableCount).toBe(document.model.stats.tableCount)
    expect(again.model.stats.imageCount).toBe(document.model.stats.imageCount)
  })

  it('layout: off 면 캐시를 남긴다 — 비교 실험용', async () => {
    const { document } = await open()
    const target = document.model.sections[0]!.paragraphs.find((p) => p.text.includes('2025년'))!
    document.apply({
      operations: [
        { type: 'replace_text', paragraphId: target.id, oldText: target.text, newText: '짧게' },
      ],
    })
    expect(countSegs(await sectionText(await document.toBytes({ layout: 'off' })))).toBeGreaterThan(0)
  })

  it('본문 XML 말고 다른 ZIP 항목은 건드리지 않는다', async () => {
    const { bytes, document } = await open()
    const target = document.model.sections[0]!.paragraphs.find((p) => p.text.includes('2025년'))!
    document.apply({
      operations: [
        { type: 'replace_text', paragraphId: target.id, oldText: target.text, newText: '바뀐 제목' },
      ],
    })
    const out = await document.toBytes()

    const before = ZipArchive.open(bytes)
    const after = ZipArchive.open(out)
    expect(after.entries.map((e) => e.name)).toEqual(before.entries.map((e) => e.name))
    expect(after.entries.map((e) => e.compressionMethod)).toEqual(
      before.entries.map((e) => e.compressionMethod),
    )
    const changed: string[] = []
    for (const entry of before.entries) {
      if (!identical(await before.read(entry.name), await after.read(entry.name))) {
        changed.push(entry.name)
      }
    }
    expect(changed).toEqual(['Contents/section0.xml'])
  })

  it('빈 칸을 채운 뒤에도 캐시가 걷히고 라벨이 남는다', async () => {
    const { document } = await open([BLANK_FORM_XML])
    const blank = document.model.sections[0]!.paragraphs.find((p) => p.emptySlot)!
    document.apply({
      operations: [
        {
          type: 'replace_text',
          paragraphId: blank.id,
          oldText: '',
          newText: '여러 줄이 될 만큼 긴 값을 넣는다. '.repeat(10),
        },
      ],
    })
    const out = await document.toBytes()
    expect(countSegs(await sectionText(out))).toBe(0)

    const again = await loadHwpxBytes(out, 'again.hwpx')
    const texts = again.model.sections.flatMap((s) => s.paragraphs.map((p) => p.text))
    expect(texts).toContain('팀 명')
    expect(texts.some((t) => t.startsWith('여러 줄이 될 만큼'))).toBe(true)
  })
})

describe('section XML 이 여럿이어도 각각 처리한다', () => {
  it('두 번째 section 의 캐시도 걷어낸다', async () => {
    const { loaded } = await open([SECTION_XML, SECTION_XML])
    expect(loaded.model.sections).toHaveLength(2)
    const before = new Map(loaded.sectionBytes)
    const { sections } = normalizeLayout(loaded.model, before, [], 'all')
    expect(sections.size).toBe(2)
    for (const bytes of sections.values()) {
      expect(countSegs(new TextDecoder().decode(bytes))).toBe(0)
    }
  })
})


// ── 페이지를 넘칠 것 같은 표 ──────────────────────────────────────────

describe('표가 페이지를 넘칠 때만 흐르도록 바꾼다', () => {
  const openTable = async (options: Parameters<typeof pageTableXml>[0] = {}) => {
    const bytes = await buildHwpx({ sections: [pageTableXml(options)] })
    const loaded = await loadHwpxBytes(bytes, 'table.hwpx')
    const document = HwpxDocument.fromLoadResult(loaded)
    const cells = document.model.sections[0]!.paragraphs.filter((p) => p.text.includes('행'))
    return { document, cells }
  }
  const grow = (document: HwpxDocument, cells: { id: string; text: string }[], times: number) =>
    document.apply({
      operations: cells.map((c) => ({
        type: 'replace_text' as const,
        paragraphId: c.id,
        oldText: c.text,
        newText: c.text.repeat(times),
      })),
    })

  it('용지와 여백을 읽어 쓸 수 있는 높이를 안다', async () => {
    const { document } = await openTable()
    // 84186 - 4251*2 - 2834*2
    expect(usableHeight(document.model.sections[0]!.page)).toBe(70016)
  })

  it('조금만 늘리면 표 속성을 건드리지 않는다', async () => {
    const { document, cells } = await openTable({ rows: 4, cellHeight: 4000 })
    grow(document, cells.slice(0, 1), 2)
    const out = await document.toBytes()
    expect(document.layoutReport!.tablesMadeFlowable).toEqual([])
    const xml = new TextDecoder().decode(await ZipArchive.open(out).read('Contents/section0.xml'))
    expect(xml).toContain('treatAsChar="0"')
  })

  it('넘칠 만큼 늘리면 글자처럼 취급하도록 바꾼다', async () => {
    const { document, cells } = await openTable({ rows: 8, cellHeight: 8000 })
    grow(document, cells, 12)
    const out = await document.toBytes()
    expect(document.layoutReport!.tablesMadeFlowable).toHaveLength(1)
    const xml = new TextDecoder().decode(await ZipArchive.open(out).read('Contents/section0.xml'))
    expect(xml).toContain('treatAsChar="1"')
    expect(xml).not.toContain('treatAsChar="0"')
    // 표 구조와 글자는 그대로다.
    const again = await loadHwpxBytes(out, 'again.hwpx')
    expect(again.model.stats.tableCount).toBe(document.model.stats.tableCount)
    expect(again.model.stats.paragraphCount).toBe(document.model.stats.paragraphCount)
  })

  it('표 단위 넘김도 셀 단위로 바꾼다', async () => {
    const { document, cells } = await openTable({
      rows: 8,
      cellHeight: 8000,
      treatAsChar: '1',
      pageBreak: 'TABLE',
    })
    grow(document, cells, 12)
    const xml = new TextDecoder().decode(
      await ZipArchive.open(await document.toBytes()).read('Contents/section0.xml'),
    )
    expect(xml).toContain('pageBreak="CELL"')
    expect(xml).not.toContain('pageBreak="TABLE"')
  })

  it('세로로 병합된 칸이 있으면 못 나눈다고 알린다', async () => {
    const { document, cells } = await openTable({ rows: 8, cellHeight: 8000, rowSpan: 2 })
    grow(document, cells, 12)
    await document.toBytes()
    const stuck = document.layoutReport!.tablesStillStuck
    expect(stuck).toHaveLength(1)
    expect(stuck[0]!.reason).toMatch(/세로로 병합된 칸/)
  })

  it('나눌 수 있는 표는 막힌 표로 보고하지 않는다', async () => {
    const { document, cells } = await openTable({ rows: 8, cellHeight: 8000, treatAsChar: '1' })
    grow(document, cells, 12)
    await document.toBytes()
    expect(document.layoutReport!.tablesStillStuck).toEqual([])
  })
})

describe('AI에게 보내는 목록', () => {
  it('못 나누는 표의 칸에는 짧게 쓰라고 표시한다', async () => {
    const bytes = await buildHwpx({
      sections: [pageTableXml({ rows: 12, cellHeight: 6000, rowSpan: 2 })],
    })
    const loaded = await loadHwpxBytes(bytes, 'table.hwpx')
    const marked = collectParagraphs(loaded.model).filter((p) => p.where.includes('짧게 쓸 것'))
    expect(marked.length).toBeGreaterThan(0)
  })

  it('여유가 있는 표에는 표시하지 않는다', async () => {
    const bytes = await buildHwpx({
      sections: [pageTableXml({ rows: 3, cellHeight: 2000, rowSpan: 2 })],
    })
    const loaded = await loadHwpxBytes(bytes, 'table.hwpx')
    const marked = collectParagraphs(loaded.model).filter((p) => p.where.includes('짧게 쓸 것'))
    expect(marked).toEqual([])
  })
})
