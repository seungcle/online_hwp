/**
 * AI와 주고받는 계약. 브라우저와 Worker가 같은 파일을 쓴다.
 *
 * 응답을 자유 텍스트로 받아 파싱하지 않는다. OpenAI Structured Outputs
 * (`response_format: json_schema`, `strict: true`)로 형태를 강제하고,
 * 그렇게 받은 값도 **브라우저에서 한 번 더 검증**한다. 그리고 patch engine이
 * `oldText`가 실제 문서와 일치하는지 최종 확인한다. 검증이 세 겹인 이유는
 * 이 중 어느 하나라도 통과하면 문서가 망가질 수 있기 때문이다.
 */

export const EDIT_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: '무엇을 왜 바꿨는지 한국어 한두 문장 요약.',
    },
    operations: {
      type: 'array',
      description: '수정할 문단 목록. 바꿀 것이 없으면 빈 배열.',
      items: {
        type: 'object',
        properties: {
          paragraphId: {
            type: 'string',
            description: '수정할 문단의 id. 반드시 입력으로 받은 id 중 하나여야 한다.',
          },
          oldText: {
            type: 'string',
            description: '해당 문단의 현재 전체 텍스트. 한 글자도 바꾸지 말고 그대로 옮길 것.',
          },
          newText: {
            type: 'string',
            description: '그 문단을 대체할 전체 텍스트.',
          },
          reason: {
            type: 'string',
            description: '이 문단을 바꾼 이유 한 문장.',
          },
        },
        required: ['paragraphId', 'oldText', 'newText', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'operations'],
  additionalProperties: false,
} as const

export const SYSTEM_PROMPT = `너는 한글(HWPX) 문서의 텍스트를 수정하는 도구다.

입력으로 문서의 문단 목록을 받는다. 각 문단은 id와 현재 텍스트를 가진다.
사용자의 요청을 읽고, 바꿔야 하는 문단만 골라 수정 계획을 만든다.

반드시 지킬 것:
- paragraphId는 입력에 있는 id만 쓴다. 새로 만들지 않는다.
- oldText는 그 문단의 현재 텍스트를 공백까지 그대로 옮긴다. 요약하거나 다듬지 않는다.
- newText는 그 문단을 통째로 대체할 텍스트다. 문단의 일부만 적지 않는다.
- 바꿀 필요가 없는 문단은 계획에 넣지 않는다.
- 문서의 말투, 문체, 서식 관례(번호 매기기, 기호, 들여쓰기 표시 등)를 유지한다.
- 표 안 문단은 보통 짧은 값이다. 셀에 맞는 길이로 쓴다.
- 줄바꿈 문자를 넣지 않는다. 문단을 나누거나 합칠 수 없다.
- 요청이 문서와 관계없거나 바꿀 것이 없으면 operations를 빈 배열로 두고
  summary에 이유를 적는다.`

export interface DocumentParagraph {
  readonly id: string
  readonly text: string
  /** `본문` 또는 `표` 같은 위치 힌트. */
  readonly where: string
}

export interface EditPlanRequest {
  readonly instruction: string
  readonly paragraphs: readonly DocumentParagraph[]
}

export interface EditPlanOperation {
  readonly paragraphId: string
  readonly oldText: string
  readonly newText: string
  readonly reason: string
}

export interface EditPlanResponse {
  readonly summary: string
  readonly operations: readonly EditPlanOperation[]
}

/** AI가 다룰 수 있는 문서 크기 상한. 넘으면 요청 전에 막는다. */
export const MAX_PARAGRAPHS = 1500
export const MAX_TOTAL_CHARS = 120_000
export const MAX_INSTRUCTION_CHARS = 4_000

export class SchemaError extends Error {
  override name = 'SchemaError'
}

/**
 * 받은 값이 실제로 계약을 지키는지 확인한다.
 * Structured Outputs를 쓰더라도 여기서 다시 본다.
 */
export function parseEditPlanResponse(value: unknown): EditPlanResponse {
  if (typeof value !== 'object' || value === null) {
    throw new SchemaError('AI 응답이 객체가 아닙니다.')
  }
  const record = value as Record<string, unknown>
  if (typeof record['summary'] !== 'string') {
    throw new SchemaError('AI 응답에 summary가 없습니다.')
  }
  if (!Array.isArray(record['operations'])) {
    throw new SchemaError('AI 응답에 operations 배열이 없습니다.')
  }

  const operations: EditPlanOperation[] = record['operations'].map((raw, position) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new SchemaError(`operations[${position}]가 객체가 아닙니다.`)
    }
    const item = raw as Record<string, unknown>
    for (const key of ['paragraphId', 'oldText', 'newText'] as const) {
      if (typeof item[key] !== 'string') {
        throw new SchemaError(`operations[${position}].${key}가 문자열이 아닙니다.`)
      }
    }
    if ((item['paragraphId'] as string).length === 0) {
      throw new SchemaError(`operations[${position}].paragraphId가 비어 있습니다.`)
    }
    return {
      paragraphId: item['paragraphId'] as string,
      oldText: item['oldText'] as string,
      newText: item['newText'] as string,
      reason: typeof item['reason'] === 'string' ? item['reason'] : '',
    }
  })

  return { summary: record['summary'], operations }
}

export function validateRequest(request: EditPlanRequest): void {
  if (!request.instruction.trim()) {
    throw new SchemaError('수정 요청 내용이 비어 있습니다.')
  }
  if (request.instruction.length > MAX_INSTRUCTION_CHARS) {
    throw new SchemaError(`요청이 너무 깁니다. ${MAX_INSTRUCTION_CHARS}자 이내로 써 주세요.`)
  }
  if (request.paragraphs.length === 0) {
    throw new SchemaError('문서에 수정할 텍스트가 없습니다.')
  }
  if (request.paragraphs.length > MAX_PARAGRAPHS) {
    throw new SchemaError(
      `문단이 너무 많습니다(${request.paragraphs.length}개). 현재는 ${MAX_PARAGRAPHS}개까지 지원합니다.`,
    )
  }
  const total = request.paragraphs.reduce((sum, item) => sum + item.text.length, 0)
  if (total > MAX_TOTAL_CHARS) {
    throw new SchemaError(
      `문서가 너무 깁니다(${total.toLocaleString('ko-KR')}자). 현재는 ${MAX_TOTAL_CHARS.toLocaleString('ko-KR')}자까지 지원합니다.`,
    )
  }
}
