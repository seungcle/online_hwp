/** AI 계약: 응답 스키마 검증과 요청 준비. */

import { describe, expect, it } from 'vitest'
import { buildHwpx } from './helpers/hwpx-fixture'
import { loadHwpxBytes } from '../frontend/src/hwpx/package'
import { collectParagraphs, resolveEditPlan } from '../frontend/src/ai/client'
import { PatchError } from '../frontend/src/hwpx/patch'
import {
  EDIT_PLAN_SCHEMA,
  MAX_INSTRUCTION_CHARS,
  SchemaError,
  paragraphChecksum,
  parseEditPlanResponse,
  validateRequest,
} from '../frontend/src/ai/schema'

describe('parseEditPlanResponse', () => {
  it('정상 응답을 통과시킨다', () => {
    const plan = parseEditPlanResponse({
      summary: '기간을 바꿨습니다.',
      operations: [
        { paragraphId: 's0-p1', checksum: 'deadbeef', newText: '3개월', reason: '요청대로' },
      ],
    })
    expect(plan.operations).toHaveLength(1)
    expect(plan.operations[0]!.newText).toBe('3개월')
  })

  it('빈 operations를 허용한다', () => {
    expect(parseEditPlanResponse({ summary: '바꿀 것이 없습니다.', operations: [] }).operations)
      .toHaveLength(0)
  })

  it('reason이 없어도 받아들인다', () => {
    const plan = parseEditPlanResponse({
      summary: 's',
      operations: [{ paragraphId: 'a', checksum: 'b', newText: 'c' }],
    })
    expect(plan.operations[0]!.reason).toBe('')
  })

  it.each([
    ['객체가 아님', 'not an object'],
    ['null', null],
    ['summary 없음', { operations: [] }],
    ['operations 없음', { summary: 's' }],
    ['operations가 배열이 아님', { summary: 's', operations: {} }],
  ])('잘못된 응답을 거부한다: %s', (_label, value) => {
    expect(() => parseEditPlanResponse(value)).toThrow(SchemaError)
  })

  it('operation 필드 타입이 틀리면 거부한다', () => {
    expect(() =>
      parseEditPlanResponse({
        summary: 's',
        operations: [{ paragraphId: 's0-p1', checksum: 1, newText: 'x' }],
      }),
    ).toThrow(/checksum/)
  })

  it('paragraphId가 비어 있으면 거부한다', () => {
    expect(() =>
      parseEditPlanResponse({
        summary: 's',
        operations: [{ paragraphId: '', checksum: 'a', newText: 'b' }],
      }),
    ).toThrow(/비어 있습니다/)
  })

  it('AI가 임의 필드를 덧붙여도 무시하고 필요한 것만 취한다', () => {
    const plan = parseEditPlanResponse({
      summary: 's',
      operations: [{ paragraphId: 'a', checksum: 'b', newText: 'c', 위험한필드: '<script>' }],
    })
    expect(Object.keys(plan.operations[0]!)).toEqual([
      'paragraphId',
      'checksum',
      'newText',
      'reason',
    ])
  })
})

describe('validateRequest', () => {
  const paragraphs = [{ id: 's0-p0', text: '안녕하세요', where: '본문' }]

  it('정상 요청을 통과시킨다', () => {
    expect(() => validateRequest({ instruction: '바꿔줘', paragraphs })).not.toThrow()
  })

  it('빈 요청을 거부한다', () => {
    expect(() => validateRequest({ instruction: '   ', paragraphs })).toThrow(/비어 있습니다/)
  })

  it('너무 긴 요청을 거부한다', () => {
    expect(() =>
      validateRequest({ instruction: 'x'.repeat(MAX_INSTRUCTION_CHARS + 1), paragraphs }),
    ).toThrow(/너무 깁니다/)
  })

  it('문단이 없으면 거부한다', () => {
    expect(() => validateRequest({ instruction: '바꿔줘', paragraphs: [] })).toThrow(
      /수정할 텍스트가 없습니다/,
    )
  })

  it('문서가 너무 길면 거부한다', () => {
    const huge = [{ id: 's0-p0', text: '가'.repeat(200_000), where: '본문' }]
    expect(() => validateRequest({ instruction: '바꿔줘', paragraphs: huge })).toThrow(
      /문서가 너무 깁니다/,
    )
  })

  it('문단 수가 너무 많으면 거부한다', () => {
    const many = Array.from({ length: 2000 }, (_unused, i) => ({
      id: `s0-p${i}`,
      text: '짧음',
      where: '본문',
    }))
    expect(() => validateRequest({ instruction: '바꿔줘', paragraphs: many })).toThrow(
      /문단이 너무 많습니다/,
    )
  })
})

describe('collectParagraphs', () => {
  it('빈 문단을 빼고 표 위치를 표시한다', async () => {
    const result = await loadHwpxBytes(await buildHwpx(), 'sample.hwpx')
    const paragraphs = collectParagraphs(result.model)

    expect(paragraphs.every((p) => p.text.trim().length > 0)).toBe(true)
    expect(paragraphs.some((p) => p.where === '본문')).toBe(true)
    expect(paragraphs.some((p) => p.where.startsWith('표 '))).toBe(true)
    expect(paragraphs.map((p) => p.id)).toContain('s0-p0')
  })

  it('AI에 파일이나 XML을 보내지 않는다 — id/텍스트/위치뿐', async () => {
    const result = await loadHwpxBytes(await buildHwpx(), 'sample.hwpx')
    const [first] = collectParagraphs(result.model)
    expect(Object.keys(first!).sort()).toEqual(['id', 'text', 'where'])
  })
})

describe('EDIT_PLAN_SCHEMA', () => {
  it('Structured Outputs strict 모드 요구사항을 지킨다', () => {
    // strict 모드는 모든 속성이 required이고 additionalProperties가 false여야 한다.
    expect(EDIT_PLAN_SCHEMA.additionalProperties).toBe(false)
    expect([...EDIT_PLAN_SCHEMA.required].sort()).toEqual(
      Object.keys(EDIT_PLAN_SCHEMA.properties).sort(),
    )
    const item = EDIT_PLAN_SCHEMA.properties.operations.items
    expect(item.additionalProperties).toBe(false)
    expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort())
  })
})

describe('paragraphChecksum', () => {
  it('같은 문자열이면 같은 값, 공백 한 칸만 달라도 다른 값', () => {
    expect(paragraphChecksum('   - 가나다')).toBe(paragraphChecksum('   - 가나다'))
    expect(paragraphChecksum('   - 가나다')).not.toBe(paragraphChecksum(' - 가나다'))
    expect(paragraphChecksum('가나다')).not.toBe(paragraphChecksum('가나다 '))
    // 제로폭 공백처럼 눈에 보이지 않는 차이도 잡는다.
    expect(paragraphChecksum('가나다')).not.toBe(paragraphChecksum('가나\u200b다'))
  })

  it('짧은 hex 8자리다 — 모델이 옮겨 적을 수 있어야 한다', () => {
    expect(paragraphChecksum('아무 문장')).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('resolveEditPlan', () => {
  const paragraphs = [
    { id: 's0-p0', text: '   - 들여쓰기가 있는 문단', where: '본문' },
    { id: 's0-p1', text: '평범한 문단', where: '본문' },
  ]
  const ok = (id: string, newText: string) => ({
    paragraphId: id,
    checksum: paragraphChecksum(paragraphs.find((p) => p.id === id)!.text),
    newText,
    reason: '요청',
  })

  it('oldText를 AI가 아니라 보낸 문단 목록에서 채운다', () => {
    const plan = resolveEditPlan({ summary: 's', operations: [ok('s0-p0', '바뀐 문장')] }, paragraphs)
    // 들여쓰기 공백 세 칸이 그대로 살아 있어야 한다. AI는 이 값을 만들지 않았다.
    expect(plan.operations[0]!.oldText).toBe('   - 들여쓰기가 있는 문단')
    // 앞 공백은 원문을 따른다 — 아래 '원문 앞뒤 공백' 묶음을 보라.
    expect(plan.operations[0]!.newText).toBe('   바뀐 문장')
    expect(plan.operations[0]!.type).toBe('replace_text')
  })

  it('AI가 원문을 다듬어 보내도 상관없다 — 원문을 AI에게 받지 않기 때문', () => {
    // 예전에 실서비스를 막았던 바로 그 상황: 모델이 공백 세 칸을 한 칸으로 줄인다.
    const response = {
      summary: 's',
      operations: [{ ...ok('s0-p0', '바뀐 문장'), oldText: ' - 들여쓰기가 있는 문단' } as never],
    }
    const plan = resolveEditPlan(response, paragraphs)
    expect(plan.operations).toHaveLength(1)
    expect(plan.operations[0]!.oldText).toBe('   - 들여쓰기가 있는 문단')
  })

  it('검증코드가 다른 문단의 것이면 계획 전체를 버린다', () => {
    const crossed = {
      paragraphId: 's0-p0',
      checksum: paragraphChecksum(paragraphs[1]!.text),
      newText: '바뀐 문장',
      reason: '요청',
    }
    expect(() =>
      resolveEditPlan({ summary: 's', operations: [crossed, ok('s0-p1', '다른 문장')] }, paragraphs),
    ).toThrow(PatchError)
    try {
      resolveEditPlan({ summary: 's', operations: [crossed] }, paragraphs)
    } catch (error) {
      expect((error as PatchError).issues[0]!.kind).toBe('checksum-mismatch')
    }
  })

  it('없는 문단 id를 거부한다', () => {
    expect(() =>
      resolveEditPlan({ summary: 's', operations: [{ ...ok('s0-p0', 'x'), paragraphId: 's9-p9' }] }, paragraphs),
    ).toThrow(PatchError)
  })

  it('같은 문단을 두 번 고치려 하면 거부한다', () => {
    expect(() =>
      resolveEditPlan({ summary: 's', operations: [ok('s0-p0', 'a'), ok('s0-p0', 'b')] }, paragraphs),
    ).toThrow(PatchError)
  })
})

describe('resolveEditPlan — 원문 앞뒤 공백', () => {
  const paragraphs = [
    { id: 's0-p0', text: '   - 들여쓰기가 있는 문단', where: '본문' },
    { id: 's0-p1', text: '붙임1  ', where: '본문' },
    { id: 's0-p2', text: '평범한 문단', where: '본문' },
  ]
  const op = (id: string, newText: string) => ({
    paragraphId: id,
    checksum: paragraphChecksum(paragraphs.find((p) => p.id === id)!.text),
    newText,
    reason: '요청',
  })
  const resolve = (id: string, newText: string) =>
    resolveEditPlan({ summary: 's', operations: [op(id, newText)] }, paragraphs).operations[0]!
      .newText

  it('모델이 앞 공백을 지워도 원문 그대로 되돌린다', () => {
    // 실측: gpt-4.1-mini는 프롬프트로 부탁해도 들여쓰기를 떨어뜨린다.
    expect(resolve('s0-p0', '- 다듬은 문단')).toBe('   - 다듬은 문단')
    expect(resolve('s0-p0', '   - 다듬은 문단')).toBe('   - 다듬은 문단')
  })

  it('뒤쪽 공백도 원문을 따른다', () => {
    expect(resolve('s0-p1', '붙임2')).toBe('붙임2  ')
  })

  it('원문에 여백이 없으면 손대지 않는다', () => {
    expect(resolve('s0-p2', '다듬은 문단')).toBe('다듬은 문단')
  })

  it('내용을 비우는 수정은 그대로 둔다 — 공백만 남기지 않는다', () => {
    expect(resolve('s0-p0', '')).toBe('')
  })
})
