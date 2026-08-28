import { describe, expect, it } from 'vitest'
import { SECTION_XML, cell, para, run, table, text } from './helpers/hwpx-fixture'
import { buildDocumentModel, parseSection, type Block, type Paragraph } from '../src/hwpx/document'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

function sectionOf(xml: string) {
  return parseSection(encode(xml), 0, 'Contents/section0.xml')
}

function wrap(body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" ' +
    `xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${body}</hs:sec>`
  )
}

const texts = (blocks: readonly Block[]): string[] =>
  blocks.flatMap((block) => {
    if (block.kind === 'paragraph') return [block.text]
    if (block.kind === 'image') return []
    return block.rows.flatMap((row) => row.flatMap((c) => texts(c.blocks)))
  })

describe('parseSection', () => {
  const section = sectionOf(SECTION_XML)
  const byText = (value: string): Paragraph =>
    section.paragraphs.find((paragraph) => paragraph.text === value)!

  it('일반 문단 텍스트를 추출한다', () => {
    expect(byText('2025년 사업 제안서')).toBeDefined()
  })

  it('여러 run으로 갈라진 문장을 하나로 잇는다', () => {
    const paragraph = byText('사업 기간은 1년 입니다.')
    expect(paragraph).toBeDefined()
    expect(paragraph.split).toBe(true)
    expect(paragraph.fragments).toHaveLength(3)
  })

  it('hp:t 안에서 text/tail로 갈라진 문장을 하나로 잇는다', () => {
    const paragraph = byText('대상은 중학생입니다.')
    expect(paragraph).toBeDefined()
    expect(paragraph.fragments).toHaveLength(3)
    expect(paragraph.fragments.map((fragment) => fragment.text)).toEqual([
      '대상은 ',
      '중학생',
      '입니다.',
    ])
  })

  it('조각의 바이트 구간이 원본 XML을 정확히 가리킨다', () => {
    const bytes = encode(SECTION_XML)
    const decoder = new TextDecoder()
    for (const paragraph of section.paragraphs) {
      for (const fragment of paragraph.fragments) {
        const raw = decoder.decode(bytes.subarray(fragment.start, fragment.end))
        const decoded = raw
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
        expect(decoded).toBe(fragment.text)
      }
    }
  })

  it('조각 구간이 서로 겹치지 않는다', () => {
    const spans = section.paragraphs
      .flatMap((paragraph) => paragraph.fragments)
      .sort((a, b) => a.start - b.start)
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end)
    }
  })

  it('XML 엔티티를 푼 텍스트를 준다', () => {
    expect(byText('조건: A & B < C > D')).toBeDefined()
  })

  it('빈 문단을 잃어버리지 않는다', () => {
    expect(section.paragraphs.some((paragraph) => paragraph.text === '')).toBe(true)
  })

  it('표 안 텍스트를 셀 구조 그대로 추출한다', () => {
    const tables = section.blocks.filter((block) => block.kind === 'table')
    expect(tables).toHaveLength(1)
    const first = tables[0]!
    expect(first.rows).toHaveLength(2)
    expect(texts(first.rows[0]![0]!.blocks)).toEqual(['항목'])
    expect(texts(first.rows[1]![1]!.blocks)).toEqual(['1년'])
  })

  it('표 셀 안에서 갈라진 문장도 이어붙인다', () => {
    const paragraph = section.paragraphs.find((p) => p.text === '1년')!
    expect(paragraph.split).toBe(true)
  })

  it('바깥 문단이 표 안 텍스트를 흡수하지 않는다', () => {
    expect(section.paragraphs.some((paragraph) => paragraph.text.includes('항목내용'))).toBe(false)
  })

  it('셀 주소를 읽는다', () => {
    const first = section.blocks.find((block) => block.kind === 'table')!
    expect(first.rows[1]![0]!.row).toBe(1)
    expect(first.rows[1]![1]!.column).toBe(1)
  })

  it('표 뒤의 문단이 순서대로 남는다', () => {
    const last = section.blocks.at(-1)
    expect(last?.kind).toBe('paragraph')
    expect((last as Paragraph).text).toBe('문의: 담당자 ☎ 02-000-0000')
  })

  it('문단 id가 안정적이고 섹션 번호를 포함한다', () => {
    expect(section.paragraphs[0]!.id).toBe('s0-p0')
    const other = parseSection(encode(SECTION_XML), 2, 'Contents/section2.xml')
    expect(other.paragraphs[0]!.id).toBe('s2-p0')
  })

  it('중첩된 표(셀 안의 표)를 처리한다', () => {
    const inner = table([cell(para(run(text('깊은 셀'))))])
    const outer = table([cell(para(run(inner)))])
    const parsed = sectionOf(wrap(para(run(outer))))
    expect(texts(parsed.blocks)).toContain('깊은 셀')
  })

  it('한글 문단 네임스페이스가 없으면 오류를 낸다', () => {
    expect(() => sectionOf('<a/>')).toThrow(/네임스페이스/)
  })

  it('run 밖의 텍스트는 본문으로 세지 않는다', () => {
    const parsed = sectionOf(wrap(para('<hp:linesegarray>무시</hp:linesegarray>' + run(text('본문')))))
    expect(parsed.paragraphs[0]!.text).toBe('본문')
  })
})

describe('buildDocumentModel', () => {
  it('분할 문단 통계를 집계한다', () => {
    const model = buildDocumentModel([sectionOf(SECTION_XML)])
    expect(model.stats.tableCount).toBe(1)
    expect(model.stats.splitParagraphCount).toBeGreaterThanOrEqual(3)
    expect(model.stats.textParagraphCount).toBeLessThan(model.stats.paragraphCount)
    expect(model.stats.characterCount).toBeGreaterThan(0)
  })

  it('여러 섹션을 합산한다', () => {
    const model = buildDocumentModel([
      sectionOf(SECTION_XML),
      parseSection(encode(SECTION_XML), 1, 'Contents/section1.xml'),
    ])
    expect(model.stats.tableCount).toBe(2)
  })
})
