/** AI 계약: 응답 스키마 검증과 요청 준비. */

import { describe, expect, it } from 'vitest'
import { buildHwpx } from './helpers/hwpx-fixture'
import { loadHwpxBytes } from '../frontend/src/hwpx/package'
import { collectParagraphs } from '../frontend/src/ai/client'
import {
  EDIT_PLAN_SCHEMA,
  MAX_INSTRUCTION_CHARS,
  SchemaError,
  parseEditPlanResponse,
  validateRequest,
} from '../frontend/src/ai/schema'

describe('parseEditPlanResponse', () => {
  it('정상 응답을 통과시킨다', () => {
    const plan = parseEditPlanResponse({
      summary: '기간을 바꿨습니다.',
      operations: [
        { paragraphId: 's0-p1', oldText: '1년', newText: '3개월', reason: '요청대로' },
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
      operations: [{ paragraphId: 'a', oldText: 'b', newText: 'c' }],
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
        operations: [{ paragraphId: 's0-p1', oldText: 1, newText: 'x' }],
      }),
    ).toThrow(/oldText/)
  })

  it('paragraphId가 비어 있으면 거부한다', () => {
    expect(() =>
      parseEditPlanResponse({
        summary: 's',
        operations: [{ paragraphId: '', oldText: 'a', newText: 'b' }],
      }),
    ).toThrow(/비어 있습니다/)
  })

  it('AI가 임의 필드를 덧붙여도 무시하고 필요한 것만 취한다', () => {
    const plan = parseEditPlanResponse({
      summary: 's',
      operations: [{ paragraphId: 'a', oldText: 'b', newText: 'c', 위험한필드: '<script>' }],
    })
    expect(Object.keys(plan.operations[0]!)).toEqual([
      'paragraphId',
      'oldText',
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
