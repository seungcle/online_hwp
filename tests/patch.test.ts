/**
 * patch engine. 이 프로젝트에서 가장 망가지면 안 되는 부분이다.
 */

import { describe, expect, it } from 'vitest'
import { buildHwpx, SECTION_XML } from './helpers/hwpx-fixture'
import { loadHwpxBytes } from '../frontend/src/hwpx/package'
import { HwpxDocument } from '../frontend/src/hwpx/session'
import { PatchError, applyPlan, validatePlan, type EditPlan } from '../frontend/src/hwpx/patch'
import { parseSection, type Block, type Paragraph } from '../frontend/src/hwpx/document'
import { ZipArchive } from '../frontend/src/hwpx/zip'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
const decode = (value: Uint8Array): string => new TextDecoder().decode(value)

async function openDocument(bytes?: Uint8Array): Promise<HwpxDocument> {
  const result = await loadHwpxBytes(bytes ?? (await buildHwpx()), 'sample.hwpx')
  return HwpxDocument.fromLoadResult(result)
}

function texts(blocks: readonly Block[]): string[] {
  return blocks.flatMap((block) => {
    if (block.kind === 'paragraph') return [block.text]
    if (block.kind === 'image') return []
    return block.rows.flatMap((row) => row.flatMap((cell) => texts(cell.blocks)))
  })
}

function paragraphByText(document: HwpxDocument, value: string): Paragraph {
  const found = document.model.sections
    .flatMap((section) => section.paragraphs)
    .find((paragraph) => paragraph.text === value)
  if (!found) throw new Error(`문단을 찾지 못했습니다: ${value}`)
  return found
}

function plan(operations: EditPlan['operations']): EditPlan {
  return { operations, summary: '테스트' }
}

describe('applyPlan — 성공 경로', () => {
  it('한 조각짜리 일반 문단을 바꾼다', async () => {
    const document = await openDocument()
    const target = paragraphByText(document, '2025년 사업 제안서')
    document.apply(
      plan([
        {
          type: 'replace_text',
          paragraphId: target.id,
          oldText: '2025년 사업 제안서',
          newText: 'AI 교육 사업 제안서',
        },
      ]),
    )
    expect(texts(document.model.sections[0]!.blocks)).toContain('AI 교육 사업 제안서')
  })

  it('여러 run으로 갈라진 문단을 바꾼다', async () => {
    const document = await openDocument()
    const target = paragraphByText(document, '사업 기간은 1년 입니다.')
    expect(target.fragments).toHaveLength(3)
    document.apply(
      plan([
        {
          type: 'replace_text',
          paragraphId: target.id,
          oldText: '사업 기간은 1년 입니다.',
          newText: '사업 기간은 3개월입니다.',
        },
      ]),
    )
    const after = document.model.sections[0]!.paragraphs.find((p) => p.id === target.id)!
    expect(after.text).toBe('사업 기간은 3개월입니다.')
    // 값은 첫 조각에 들어가고 나머지 조각은 비워진다.
    expect(after.fragments).toHaveLength(1)
  })

  it('hp:t 안에서 text/tail로 갈라진 문단을 바꾼다', async () => {
    const document = await openDocument()
    const target = paragraphByText(document, '대상은 중학생입니다.')
    expect(target.fragments).toHaveLength(3)
    document.apply(
      plan([
        {
          type: 'replace_text',
          paragraphId: target.id,
          oldText: '대상은 중학생입니다.',
          newText: '대상은 고등학생입니다.',
        },
      ]),
    )
    expect(texts(document.model.sections[0]!.blocks)).toContain('대상은 고등학생입니다.')
  })

  it('표 셀 안의 문단을 바꾼다', async () => {
    const document = await openDocument()
    const target = paragraphByText(document, '1년')
    document.apply(
      plan([
        { type: 'replace_text', paragraphId: target.id, oldText: '1년', newText: '3개월' },
      ]),
    )
    expect(texts(document.model.sections[0]!.blocks)).toContain('3개월')
  })

  it('여러 곳을 한 번에 바꾼다', async () => {
    const document = await openDocument()
    const a = paragraphByText(document, '2025년 사업 제안서')
    const b = paragraphByText(document, '사업 기간은 1년 입니다.')
    const c = paragraphByText(document, '1년')
    const changes = document.apply(
      plan([
        { type: 'replace_text', paragraphId: a.id, oldText: a.text, newText: 'AI 교육 제안서' },
        { type: 'replace_text', paragraphId: b.id, oldText: b.text, newText: '기간은 3개월입니다.' },
        { type: 'replace_text', paragraphId: c.id, oldText: c.text, newText: '3개월' },
      ]),
    )
    expect(changes).toHaveLength(3)
    const all = texts(document.model.sections[0]!.blocks)
    expect(all).toContain('AI 교육 제안서')
    expect(all).toContain('기간은 3개월입니다.')
    expect(all).toContain('3개월')
  })

  it('XML 특수문자를 안전하게 넣는다', async () => {
    const document = await openDocument()
    const target = paragraphByText(document, '2025년 사업 제안서')
    document.apply(
      plan([
        {
          type: 'replace_text',
          paragraphId: target.id,
          oldText: target.text,
          newText: 'R&D <검토> 필요 & "인용" 100%',
        },
      ]),
    )
    const after = await reparse(document)
    expect(after).toContain('R&D <검토> 필요 & "인용" 100%')
  })

  it('이미 이스케이프된 문단도 정상 처리한다', async () => {
    const document = await openDocument()
    const target = paragraphByText(document, '조건: A & B < C > D')
    document.apply(
      plan([
        { type: 'replace_text', paragraphId: target.id, oldText: target.text, newText: 'A > B' },
      ]),
    )
    expect(await reparse(document)).toContain('A > B')
  })

  it('줄바꿈은 공백으로 바꾼다 (문단 구조를 만들지 않는다)', async () => {
    const document = await openDocument()
    const target = paragraphByText(document, '2025년 사업 제안서')
    document.apply(
      plan([
        {
          type: 'replace_text',
          paragraphId: target.id,
          oldText: target.text,
          newText: '첫 줄\n둘째 줄',
        },
      ]),
    )
    expect(await reparse(document)).toContain('첫 줄 둘째 줄')
  })

  it('문단을 빈 문자열로 지울 수 있다', async () => {
    const document = await openDocument()
    const target = paragraphByText(document, '2025년 사업 제안서')
    document.apply(
      plan([{ type: 'replace_text', paragraphId: target.id, oldText: target.text, newText: '' }]),
    )
    expect(await reparse(document)).not.toContain('2025년 사업 제안서')
  })

  it('연속으로 두 번 수정할 수 있다 (오프셋이 다시 계산된다)', async () => {
    const document = await openDocument()
    const first = paragraphByText(document, '2025년 사업 제안서')
    document.apply(
      plan([{ type: 'replace_text', paragraphId: first.id, oldText: first.text, newText: '1차 수정본' }]),
    )
    const second = paragraphByText(document, '사업 기간은 1년 입니다.')
    document.apply(
      plan([{ type: 'replace_text', paragraphId: second.id, oldText: second.text, newText: '2차 수정본' }]),
    )
    const after = await reparse(document)
    expect(after).toContain('1차 수정본')
    expect(after).toContain('2차 수정본')
    expect(document.changes).toHaveLength(2)
  })
})

describe('applyPlan — 검증 실패 시 아무것도 바꾸지 않는다', () => {
  it('없는 문단 id를 거부한다', async () => {
    const document = await openDocument()
    const before = await reparse(document)
    expect(() =>
      document.apply(
        plan([{ type: 'replace_text', paragraphId: 's9-p99', oldText: 'x', newText: 'y' }]),
      ),
    ).toThrow(PatchError)
    expect(await reparse(document)).toEqual(before)
    expect(document.pristine).toBe(true)
  })

  it('oldText가 다르면 거부한다', async () => {
    const document = await openDocument()
    const target = paragraphByText(document, '2025년 사업 제안서')
    try {
      document.apply(
        plan([
          {
            type: 'replace_text',
            paragraphId: target.id,
            oldText: '2024년 사업 제안서',
            newText: 'x',
          },
        ]),
      )
      throw new Error('예외가 발생해야 한다')
    } catch (error) {
      expect(error).toBeInstanceOf(PatchError)
      const issues = (error as PatchError).issues
      expect(issues[0]!.kind).toBe('text-mismatch')
      expect(issues[0]!.actualText).toBe('2025년 사업 제안서')
    }
  })

  it('공백 한 칸만 달라도 거부한다', async () => {
    const document = await openDocument()
    const target = paragraphByText(document, '2025년 사업 제안서')
    expect(() =>
      document.apply(
        plan([
          {
            type: 'replace_text',
            paragraphId: target.id,
            oldText: '2025년  사업 제안서',
            newText: 'x',
          },
        ]),
      ),
    ).toThrow(PatchError)
  })

  it('한 건만 틀려도 나머지까지 전부 적용하지 않는다', async () => {
    const document = await openDocument()
    const good = paragraphByText(document, '2025년 사업 제안서')
    const before = await reparse(document)
    expect(() =>
      document.apply(
        plan([
          { type: 'replace_text', paragraphId: good.id, oldText: good.text, newText: '바뀐 제목' },
          { type: 'replace_text', paragraphId: 's0-p999', oldText: 'x', newText: 'y' },
        ]),
      ),
    ).toThrow(PatchError)
    const after = await reparse(document)
    expect(after).toEqual(before)
    expect(after).not.toContain('바뀐 제목')
  })

  it('같은 문단을 두 번 수정하려 하면 거부한다', async () => {
    const document = await openDocument()
    const target = paragraphByText(document, '2025년 사업 제안서')
    const issues = validatePlan(
      document.model,
      plan([
        { type: 'replace_text', paragraphId: target.id, oldText: target.text, newText: 'A' },
        { type: 'replace_text', paragraphId: target.id, oldText: target.text, newText: 'B' },
      ]),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]!.kind).toBe('duplicate-target')
  })

  it('빈 문단에 글자를 넣으려 하면 거부한다', async () => {
    const document = await openDocument()
    const empty = document.model.sections[0]!.paragraphs.find((p) => p.fragments.length === 0)!
    const issues = validatePlan(
      document.model,
      plan([{ type: 'replace_text', paragraphId: empty.id, oldText: '', newText: '새 내용' }]),
    )
    expect(issues[0]!.kind).toBe('empty-paragraph')
    expect(() =>
      document.apply(
        plan([{ type: 'replace_text', paragraphId: empty.id, oldText: '', newText: '새 내용' }]),
      ),
    ).toThrow(PatchError)
  })

  it('문제를 첫 건에서 멈추지 않고 모두 모아 준다', async () => {
    const document = await openDocument()
    const issues = validatePlan(
      document.model,
      plan([
        { type: 'replace_text', paragraphId: 's0-p900', oldText: 'a', newText: 'b' },
        { type: 'replace_text', paragraphId: 's0-p901', oldText: 'a', newText: 'b' },
      ]),
    )
    expect(issues).toHaveLength(2)
  })

  it('빈 operations는 아무 일도 하지 않는다', async () => {
    const document = await openDocument()
    const before = await reparse(document)
    expect(document.apply(plan([]))).toEqual([])
    expect(await reparse(document)).toEqual(before)
  })
})

describe('결과 파일', () => {
  it('수정된 section만 바뀌고 나머지 항목은 바이트 그대로다', async () => {
    const original = await buildHwpx()
    const document = await openDocument(original)
    const target = paragraphByText(document, '2025년 사업 제안서')
    document.apply(
      plan([
        { type: 'replace_text', paragraphId: target.id, oldText: target.text, newText: '새 제목' },
      ]),
    )
    const output = await document.toBytes()

    const before = ZipArchive.open(original)
    const after = ZipArchive.open(output)
    expect(after.entries.map((e) => e.name)).toEqual(before.entries.map((e) => e.name))
    expect(after.entries.map((e) => e.compressionMethod)).toEqual(
      before.entries.map((e) => e.compressionMethod),
    )
    for (const entry of before.entries) {
      const oldBytes = await before.read(entry.name)
      const newBytes = await after.read(entry.name)
      if (entry.name === 'Contents/section0.xml') {
        expect(newBytes).not.toEqual(oldBytes)
      } else {
        expect(newBytes).toEqual(oldBytes)
      }
    }
  })

  it('이미지 바이트가 원본과 완전히 같다', async () => {
    const original = await buildHwpx({ imageBytes: 50_000 })
    const document = await openDocument(original)
    const target = paragraphByText(document, '2025년 사업 제안서')
    document.apply(
      plan([
        { type: 'replace_text', paragraphId: target.id, oldText: target.text, newText: '새 제목' },
      ]),
    )
    const output = await document.toBytes()
    const before = ZipArchive.open(original)
    const after = ZipArchive.open(output)
    expect(await after.read('BinData/image1.png')).toEqual(
      await before.read('BinData/image1.png'),
    )
    // 압축된 바이트까지 동일해야 한다. 다시 압축하지 않기 때문이다.
    expect(after.rawBytes(after.find('BinData/image1.png')!)).toEqual(
      before.rawBytes(before.find('BinData/image1.png')!),
    )
  })

  it('mimetype이 첫 항목이고 무압축으로 남는다', async () => {
    const document = await openDocument()
    const target = paragraphByText(document, '2025년 사업 제안서')
    document.apply(
      plan([{ type: 'replace_text', paragraphId: target.id, oldText: target.text, newText: 'x' }]),
    )
    const archive = ZipArchive.open(await document.toBytes())
    expect(archive.entries[0]!.name).toBe('mimetype')
    expect(archive.entries[0]!.compressionMethod).toBe(0)
  })

  it('결과 파일을 다시 열 수 있다', async () => {
    const document = await openDocument()
    const target = paragraphByText(document, '2025년 사업 제안서')
    document.apply(
      plan([
        { type: 'replace_text', paragraphId: target.id, oldText: target.text, newText: '다시 열기' },
      ]),
    )
    const reopened = await loadHwpxBytes(await document.toBytes(), 'result.hwpx')
    expect(texts(reopened.model.sections[0]!.blocks)).toContain('다시 열기')
    expect(reopened.model.stats.tableCount).toBe(1)
    expect(reopened.model.stats.imageCount).toBe(1)
  })

  it('수정하지 않으면 모든 항목이 원본과 같다', async () => {
    const original = await buildHwpx()
    const document = await openDocument(original)
    const output = await document.toBytes()
    const before = ZipArchive.open(original)
    const after = ZipArchive.open(output)
    for (const entry of before.entries) {
      expect(after.rawBytes(after.find(entry.name)!)).toEqual(before.rawBytes(entry))
    }
  })
})

describe('applyPlan — 순수 함수 형태', () => {
  it('원본 바이트를 변경하지 않는다', async () => {
    const bytes = encode(SECTION_XML)
    const section = parseSection(bytes, 0, 'Contents/section0.xml')
    const model = { sections: [section], stats: { paragraphCount: 0, textParagraphCount: 0, splitParagraphCount: 0, tableCount: 0, imageCount: 0, characterCount: 0 } }
    const target = section.paragraphs.find((p) => p.text === '2025년 사업 제안서')!
    const result = applyPlan(model, new Map([['Contents/section0.xml', bytes]]), plan([
      { type: 'replace_text', paragraphId: target.id, oldText: target.text, newText: '바뀜' },
    ]))
    expect(decode(bytes)).toContain('2025년 사업 제안서')
    expect(decode(result.sections.get('Contents/section0.xml')!)).toContain('바뀜')
  })
})

async function reparse(document: HwpxDocument): Promise<string[]> {
  const reopened = await loadHwpxBytes(await document.toBytes(), 'check.hwpx')
  return reopened.model.sections.flatMap((section) => texts(section.blocks))
}
