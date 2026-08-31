/**
 * patch engine. 이 프로젝트에서 가장 망가지면 안 되는 부분이다.
 */

import { describe, expect, it } from 'vitest'
import { BLANK_FORM_XML, buildHwpx, SECTION_XML, TOC_SECTION_XML } from './helpers/hwpx-fixture'
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

  it('빈 문단이라도 채울 자리가 있으면 넣는다', async () => {
    // 예전에는 빈 문단을 통째로 거절했다. 그러면 양식의 값 칸을 채울 수 없고,
    // AI가 대신 옆의 라벨을 덮어쓴다. 자리가 있으면 채우는 것이 맞다.
    const document = await openDocument()
    const empty = document.model.sections[0]!.paragraphs.find((p) => p.fragments.length === 0)!
    expect(empty.emptySlot).toBeDefined()
    expect(
      validatePlan(
        document.model,
        plan([{ type: 'replace_text', paragraphId: empty.id, oldText: '', newText: '새 내용' }]),
      ),
    ).toEqual([])
    const applied = document.apply(
      plan([{ type: 'replace_text', paragraphId: empty.id, oldText: '', newText: '새 내용' }]),
    )
    expect(applied).toHaveLength(1)
    const again = await loadHwpxBytes(await document.toBytes(), 'again.hwpx')
    expect(
      again.model.sections.flatMap((section) => section.paragraphs.map((p) => p.text)),
    ).toContain('새 내용')
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


// ── 빈 양식 칸 채우기 ────────────────────────────────────────

describe('값이 비어 있는 양식 칸', () => {
  const openBlankForm = async () => {
    const bytes = await buildHwpx({ sections: [BLANK_FORM_XML] })
    const loaded = await loadHwpxBytes(bytes, 'form.hwpx')
    const document = HwpxDocument.fromLoadResult(loaded)
    const paragraphs = document.model.sections.flatMap((section) => section.paragraphs)
    // 표를 감싼 바깥 문단도 텍스트가 없다. 채울 자리가 있는 것만 값 칸이다.
    const blanks = paragraphs.filter((paragraph) => paragraph.emptySlot !== undefined)
    return { bytes, document, paragraphs, blanks }
  }

  it('빈 run과 빈 hp:t 모두 채울 자리로 잡힌다', async () => {
    const { blanks } = await openBlankForm()
    expect(blanks).toHaveLength(2)
    expect(blanks.every((paragraph) => paragraph.text.length === 0)).toBe(true)
    // hp:t 가 이미 있으면 그쪽을 쓴다 — 건드리는 바이트가 적고 run이 그대로 남는다.
    expect(blanks.map((paragraph) => paragraph.emptySlot!.rank).sort()).toEqual([1, 2])
  })

  it('빈 칸을 채우면 다시 열었을 때 그 글자가 들어 있다', async () => {
    const { document, blanks } = await openBlankForm()
    const applied = document.apply({
      summary: '양식 채우기',
      operations: blanks.map((paragraph, index) => ({
        type: 'replace_text' as const,
        paragraphId: paragraph.id,
        oldText: '',
        newText: index === 0 ? '세종팀' : '010-1234-5678',
      })),
    })
    expect(applied).toHaveLength(2)

    const again = await loadHwpxBytes(await document.toBytes(), 'form.hwpx')
    const texts = again.model.sections.flatMap((section) =>
      section.paragraphs.map((paragraph) => paragraph.text),
    )
    expect(texts).toContain('세종팀')
    expect(texts).toContain('010-1234-5678')
    // 라벨은 그대로 남아야 한다. 이 기능이 없을 때 AI가 덮어쓰던 자리다.
    expect(texts).toContain('팀 명')
    expect(texts).toContain('연락처')
  })

  it('채운 뒤에도 글꼴 참조(charPr)가 원본 그대로다', async () => {
    const { document, blanks } = await openBlankForm()
    const blank = blanks.find((paragraph) => paragraph.emptySlot?.rank === 1)!
    document.apply({
      summary: 's',
      operations: [
        { type: 'replace_text', paragraphId: blank.id, oldText: '', newText: '세종팀' },
      ],
    })
    const archive = ZipArchive.open(await document.toBytes())
    const xml = new TextDecoder().decode(await archive.read('Contents/section0.xml'))
    expect(xml).toContain('<hp:run charPrIDRef="30"><hp:t>세종팀</hp:t></hp:run>')
  })

  it('XML 이스케이프가 필요한 값도 안전하게 들어간다', async () => {
    const { document, blanks } = await openBlankForm()
    const blank = blanks[0]!
    document.apply({
      summary: 's',
      operations: [
        { type: 'replace_text', paragraphId: blank.id, oldText: '', newText: 'A & B < C' },
      ],
    })
    const again = await loadHwpxBytes(await document.toBytes(), 'form.hwpx')
    const texts = again.model.sections.flatMap((section) =>
      section.paragraphs.map((paragraph) => paragraph.text),
    )
    expect(texts).toContain('A & B < C')
  })

  it('채울 자리가 아예 없는 빈 문단은 여전히 거절한다', async () => {
    // 기본 fixture 5번은 run 안에 빈 hp:t 가 있어 채울 수 있다. 자리가 없는
    // 문단을 흉내 내려면 run 자체가 없는 문단을 쓴다.
    const section =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' +
      '<hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" ' +
      'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" ' +
      'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section">' +
      '<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" ' +
      'merged="0"><hp:linesegarray/></hp:p>' +
      '</hs:sec>'
    const parsed = parseSection(new TextEncoder().encode(section), 0, 'Contents/section0.xml')
    const model = { sections: [parsed], stats: {} as never }
    const plan: EditPlan = {
      operations: [
        { type: 'replace_text', paragraphId: 's0-p0', oldText: '', newText: '넣을 수 없다' },
      ],
    }
    expect(validatePlan(model as never, plan).map((issue) => issue.kind)).toEqual([
      'empty-paragraph',
    ])
  })
})


// ── 탭·강제 줄나눔이 섞인 문단 ────────────────────────────────────────

describe('자리를 차지하는 요소(탭·줄나눔)', () => {
  const openToc = async () => {
    const bytes = await buildHwpx({ sections: [TOC_SECTION_XML] })
    const loaded = await loadHwpxBytes(bytes, 'toc.hwpx')
    const document = HwpxDocument.fromLoadResult(loaded)
    return { document, paragraphs: document.model.sections[0]!.paragraphs }
  }

  it('탭과 줄나눔을 문단 텍스트에 자리표로 남긴다', async () => {
    const { paragraphs } = await openToc()
    expect(paragraphs[0]!.text).toBe('Ⅰ. 훈련과정 개요 \t 01')
    expect(paragraphs[1]!.text).toBe('앞\n뒤')
    expect(paragraphs[2]!.text).toBe('탭이 없는 평범한 문단')
  })

  it('글자를 바꿔도 탭이 제자리에 그대로 남는다', async () => {
    const { document, paragraphs } = await openToc()
    const toc = paragraphs[0]!
    document.apply({
      operations: [
        {
          type: 'replace_text',
          paragraphId: toc.id,
          oldText: toc.text,
          newText: 'Ⅰ. 새로 쓴 아주 긴 훈련과정 개요 제목 \t 07',
        },
      ],
    })
    const out = await document.toBytes()
    const xml = new TextDecoder().decode(await ZipArchive.open(out).read('Contents/section0.xml'))

    // 탭 요소가 폭까지 원본 그대로여야 한다. 이것이 지워지거나 옮겨지면 안 된다.
    expect(xml).toContain('<hp:tab width="29961" leader="3" type="3"/>')
    // 글자는 탭의 앞뒤로 갈라져 들어간다 — 한쪽에 몰리면 10cm 공백이 생긴다.
    expect(xml).toContain('<hp:t>Ⅰ. 새로 쓴 아주 긴 훈련과정 개요 제목 </hp:t>')
    expect(xml).toContain('<hp:t> 07</hp:t>')

    const again = await loadHwpxBytes(out, 'again.hwpx')
    expect(again.model.sections[0]!.paragraphs[0]!.text).toBe(
      'Ⅰ. 새로 쓴 아주 긴 훈련과정 개요 제목 \t 07',
    )
  })

  it('강제 줄나눔도 제자리에 남는다', async () => {
    const { document, paragraphs } = await openToc()
    const target = paragraphs[1]!
    document.apply({
      operations: [
        { type: 'replace_text', paragraphId: target.id, oldText: target.text, newText: '위\n아래' },
      ],
    })
    const xml = new TextDecoder().decode(
      await ZipArchive.open(await document.toBytes()).read('Contents/section0.xml'),
    )
    expect(xml).toContain('<hp:lineBreak/>')
    expect((await loadHwpxBytes(await document.toBytes(), 'x.hwpx')).model.sections[0]!.paragraphs[1]!.text)
      .toBe('위\n아래')
  })

  it('탭을 빠뜨린 수정은 거부한다 — 어디에 둘지 알 수 없다', async () => {
    const { document, paragraphs } = await openToc()
    const toc = paragraphs[0]!
    const plan = {
      operations: [
        {
          type: 'replace_text' as const,
          paragraphId: toc.id,
          oldText: toc.text,
          newText: 'Ⅰ. 탭을 빠뜨린 제목 01',
        },
      ],
    }
    expect(validatePlan(document.model, plan).map((i) => i.kind)).toEqual(['anchor-mismatch'])
    expect(() => document.apply(plan)).toThrow(PatchError)
  })

  it('자리표가 없는 문단은 예전처럼 너그럽다 — 줄바꿈은 공백으로', async () => {
    const { document, paragraphs } = await openToc()
    const plain = paragraphs[2]!
    document.apply({
      operations: [
        { type: 'replace_text', paragraphId: plain.id, oldText: plain.text, newText: '한 줄\n두 줄' },
      ],
    })
    const again = await loadHwpxBytes(await document.toBytes(), 'x.hwpx')
    expect(again.model.sections[0]!.paragraphs[2]!.text).toBe('한 줄 두 줄')
  })
})
