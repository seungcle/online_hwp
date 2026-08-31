/**
 * AI와 주고받는 계약. 브라우저와 Worker가 같은 파일을 쓴다.
 *
 * 응답을 자유 텍스트로 받아 파싱하지 않는다. OpenAI Structured Outputs
 * (`response_format: json_schema`, `strict: true`)로 형태를 강제하고,
 * 그렇게 받은 값도 **브라우저에서 한 번 더 검증**한다. 그리고 patch engine이
 * `oldText`가 실제 문서와 일치하는지 최종 확인한다. 검증이 세 겹인 이유는
 * 이 중 어느 하나라도 통과하면 문서가 망가질 수 있기 때문이다.
 *
 * **AI에게 원문을 그대로 받아 적게 하지 않는다.** 예전에는 `oldText`(문단 전체
 * 텍스트)를 모델이 다시 써서 보내게 하고 그 값을 문서와 대조했다. 그런데 실제
 * 문서 문단의 27%가 들여쓰기 공백이나 연속 공백을 가지고 있어서, 모델이
 * `"   - 임상적…"`을 `" - 임상적…"`으로 줄여 쓰는 일이 계속 생겼다. 문서는
 * 멀쩡한데 검증만 실패했다.
 *
 * 그래서 대조에 쓰는 원문은 **브라우저가 자기가 보낸 값을 그대로 들고 있다가**
 * 쓴다. 모델은 그 대신 문단 줄에 적힌 짧은 검증코드(`checksum`)를 옮겨 적는다.
 * id와 내용의 결합은 그대로 바이트 단위로 확인되면서, 모델이 실패할 여지만
 * 사라진다.
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
          checksum: {
            type: 'string',
            description:
              '그 문단 줄의 대괄호 안에 적힌 검증코드. 계산하지 말고 그대로 옮겨 적을 것.',
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
        required: ['paragraphId', 'checksum', 'newText', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'operations'],
  additionalProperties: false,
} as const

export const SYSTEM_PROMPT = `너는 한글(HWPX) 문서의 텍스트를 수정하는 도구다.

입력으로 문서의 문단 목록을 받는다. 한 줄이 한 문단이고 형식은 다음과 같다.

    [문단id 검증코드] (위치) "현재 텍스트"

현재 텍스트는 JSON 문자열이다. 큰따옴표 안의 내용이 문단에 실제로 들어 있는
글자 그대로다. 맨 앞의 들여쓰기 공백, 연속된 공백, 맨 뒤 공백도 전부 문서에
실제로 있는 글자다. 눈에 잘 안 띈다고 없는 것으로 여기지 마라.

위치에는 표 번호와 칸 좌표가 들어 있고, 표 안이면 같은 행 첫 칸의 글자도
함께 붙는다. 양식은 대개 "라벨 | 값" 꼴이므로 이 힌트가 "이 칸이 무엇을 적는
자리인가"를 알려 준다. 텍스트가 빈 문자열이고 위치에 "빈 칸"이라고 적힌 줄은
아직 값이 비어 있는 칸이다. **이런 칸도 수정 대상으로 고를 수 있다.**

사용자의 요청을 읽고, 바꿔야 하는 문단만 골라 수정 계획을 만든다.

반드시 지킬 것:
- paragraphId는 입력에 있는 id만 쓴다. 새로 만들지 않는다.
- checksum은 그 문단 줄 대괄호 안의 검증코드를 그대로 옮긴다. 계산하거나
  지어내지 않는다. 고른 문단과 다른 줄에서 가져오지 않는다.
- newText는 그 문단을 통째로 대체할 텍스트다. 문단의 일부만 적지 않는다.
- newText는 원문의 앞쪽 들여쓰기 공백과 글머리 기호를 그대로 두고 시작한다.
  원문이 "   - 가나다"이면 newText도 공백 세 칸과 "- "로 시작해야 한다.
- 바꿀 필요가 없는 문단은 계획에 넣지 않는다.
- 문서의 말투, 문체, 서식 관례(번호 매기기, 기호, 들여쓰기 표시 등)를 유지한다.
- 표 안 문단은 보통 짧은 값이다. 셀에 맞는 길이로 쓴다.
- 위치에 "짧게 쓸 것"이라고 적힌 칸은 **페이지를 넘길 수 없는 표**에 들어 있다.
  세로로 병합된 칸이 있어 한글이 그 표를 다음 쪽으로 나누지 못하기 때문이다.
  그 칸은 원래 길이에서 크게 벗어나지 않게, 한두 줄 안에 쓴다. 길게 써야 할
  내용이면 그 칸 대신 표 밖의 문단을 고치거나, summary에 그 사정을 적는다.
- 줄바꿈 문자를 새로 넣지 않는다. 문단을 나누거나 합칠 수 없다.
- 텍스트 안의 \t(탭)와 \n(줄나눔)은 **문서에 실제로 박혀 있는 요소**다. 목차의
  점선처럼 자리를 차지한다. 지우거나 새로 넣지 말고 **개수와 순서를 그대로**
  둔 채 그 사이의 글자만 고친다. 예를 들어 "Ⅰ. 개요 \t 01"에서 제목만 바꾸려면
  "Ⅰ. 훈련 개요 \t 01"처럼 \t를 같은 자리에 남긴다.
- 요청이 문서와 관계없거나 바꿀 것이 없으면 operations를 빈 배열로 두고
  summary에 이유를 적는다.

양식에서 라벨과 값을 구분한다:
- "기업명", "담당자 성명", "훈련시간" 처럼 양식에 인쇄된 **라벨은 그대로 둔다.**
  사용자가 "기업명을 ○○로 바꿔줘"라고 하면 바꿀 것은 라벨이 아니라 **그 라벨이
  가리키는 값 칸**이다. 라벨 칸을 값으로 덮어쓰면 양식이 망가진다.
- 값 칸은 보통 라벨 바로 오른쪽이나 아래 칸이다. 위치 힌트의 "이 행 첫 칸"을
  보고 찾는다. 그 칸이 비어 있어도 그 칸을 고른다.

사용자는 명령어가 아니라 평소 말투로 말한다. "좀 더 읽기 쉽게", "있어 보이게",
"오타 좀" 같은 두루뭉술한 말도 요청으로 받아들이고, 문서를 읽어 알아서 판단한다.
형식을 갖춰 다시 쓰라고 요구하지 않는다.

**되묻는 것은 최후의 수단이다.** 기본은 고치는 것이다.
- 요청이 가리키는 곳이 어디인지 문서 전체와 앞뒤 문맥을 읽어 적극적으로 판단한다.
  말이 정확히 일치하지 않아도 뜻이 통하면 그 자리로 본다. "연락처"와 "전화번호",
  "기간"과 "훈련기간"처럼 표현이 달라도 같은 자리를 가리키는 일이 흔하다.
- 후보가 여럿이면 그중 **가장 그럴듯한 하나를 고른다.** 위치, 라벨, 주변 문맥,
  현재 값의 생김새를 근거로 정한다. 확신이 반반이 아니라면 고르는 쪽이 맞다.
- 정말로 우열을 가릴 수 없는 후보가 둘 이상일 때만 operations를 비우고 summary에
  한 문장으로 묻는다. 그때도 무엇과 무엇 중에 골라야 하는지 구체적으로 적는다.
- 요청이 가리키는 대상이 문서에 아예 없을 때만 operations를 비우고 없다고 적는다.
  이때 비슷한 자리를 억지로 고르지는 않는다.

앞 대화가 함께 오면 그 답을 이어받아 바로 수정한다. 예를 들어 앞에서
"제목을 무엇으로 바꿀까요?"라고 물었고 이번에 "AI 교육 제안서로"가 오면,
그것이 제목을 바꾸라는 뜻이다. 다시 묻지 않는다.`

/**
 * 문단 텍스트 하나를 짧은 검증코드로 줄인다.
 *
 * 쓰임새는 하나다. AI가 "이 id의 문단"이라고 말할 때, 그 id와 AI가 실제로 보고
 * 있던 내용이 같은 줄에서 온 것인지 확인한다. 그래서 필요한 성질도 하나다 —
 * **같은 문자열이면 브라우저와 Worker에서 같은 값이 나올 것.**
 * 보안 해시가 아니다. 8자리 hex면 모델이 옮겨 적기에 충분히 짧다.
 *
 * FNV-1a 32비트를 UTF-8 바이트에 돌린다. 공백 한 칸, 제로폭 문자 하나만
 * 달라져도 값이 달라지므로 대조는 바이트 단위 그대로다.
 */
export function paragraphChecksum(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export interface DocumentParagraph {
  readonly id: string
  readonly text: string
  /** `본문` 또는 `표` 같은 위치 힌트. */
  readonly where: string
  /**
   * 논리 경로. 예: `s0/b4/r1c0/b0`. 알려진 양식을 다시 알아볼 때 쓴다.
   * 바이트 오프셋이 아니라 "몇 번째 블록, 몇 행 몇 열"이라 재저장에 견딘다.
   */
  readonly path: string
}

/**
 * 지난 대화 한 마디. 되물음에 이어서 답할 수 있게 하려고 보낸다.
 *
 * "제목 바꿔줘" → "무엇으로 바꿀까요?" → "AI 교육 제안서로" 가 이어지려면
 * 모델이 앞 두 마디를 봐야 한다. 문단 목록은 매번 현재 문서에서 새로 만들어
 * 마지막 요청에만 싣는다. 지난 턴에는 말만 남는다.
 */
export interface ConversationTurn {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

export interface EditPlanRequest {
  readonly instruction: string
  readonly paragraphs: readonly DocumentParagraph[]
  /** 오래된 것부터. 없으면 첫 요청이다. */
  readonly history?: readonly ConversationTurn[]
  /** 구조 지문. 있으면 알려진 양식인지 먼저 찾아본다. */
  readonly structure?: {
    readonly structureHash: string
    readonly skeleton: string
    readonly paragraphCount: number
    readonly tableCount: number
    readonly imageCount: number
  }
}

/**
 * 이번 요청이 어떻게 처리됐는지. 화면에 보여 주기 위한 것이 아니라
 * 알려진 양식 경로가 실제로 도는지 확인하기 위한 것이다.
 * 문서 원문은 담지 않는다.
 */
export interface EditPlanDebug {
  readonly structureHash?: string
  readonly templateLookup: 'hit' | 'miss' | 'stale' | 'skipped' | 'unavailable'
  readonly templateId?: string
  readonly templateVersion?: number
  readonly templateName?: string
  /** 라벨이 몇 할이나 살아 있었나. 판정 근거. */
  readonly anchorRatio?: number
  /** 알려진 양식 경로를 접고 재분석으로 넘어갔는가. */
  readonly fallback?: string
  /** 이번 요청에 실제로 부른 AI 호출. `structure`가 없으면 구조 분석을 건너뛴 것이다. */
  readonly aiCalls: readonly ('structure' | 'plan' | 'plan-broadened')[]
  readonly lookupMs?: number
  readonly aiMs?: number
  readonly totalMs?: number
}

export interface EditPlanOperation {
  readonly paragraphId: string
  /** 프롬프트에 적힌 검증코드를 옮겨 적은 값. `paragraphChecksum`으로 확인한다. */
  readonly checksum: string
  readonly newText: string
  readonly reason: string
}

export interface EditPlanResponse {
  readonly summary: string
  readonly operations: readonly EditPlanOperation[]
  readonly debug?: EditPlanDebug
}

/** AI가 다룰 수 있는 문서 크기 상한. 넘으면 요청 전에 막는다. */
export const MAX_PARAGRAPHS = 1500
export const MAX_TOTAL_CHARS = 120_000
export const MAX_INSTRUCTION_CHARS = 4_000
/** 함께 보낼 지난 대화 수. 되물음 한두 번을 잇기에 충분하고 토큰도 아낀다. */
export const MAX_HISTORY_TURNS = 8

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
    for (const key of ['paragraphId', 'checksum', 'newText'] as const) {
      if (typeof item[key] !== 'string') {
        throw new SchemaError(`operations[${position}].${key}가 문자열이 아닙니다.`)
      }
    }
    if ((item['paragraphId'] as string).length === 0) {
      throw new SchemaError(`operations[${position}].paragraphId가 비어 있습니다.`)
    }
    if ((item['checksum'] as string).length === 0) {
      throw new SchemaError(`operations[${position}].checksum이 비어 있습니다.`)
    }
    return {
      paragraphId: item['paragraphId'] as string,
      checksum: item['checksum'] as string,
      newText: item['newText'] as string,
      reason: typeof item['reason'] === 'string' ? item['reason'] : '',
    }
  })

  const debug = record['debug']
  return {
    summary: record['summary'],
    operations,
    ...(debug && typeof debug === 'object' ? { debug: debug as EditPlanDebug } : {}),
  }
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
  if (request.history && request.history.length > MAX_HISTORY_TURNS) {
    throw new SchemaError(`대화 기록이 너무 깁니다(${request.history.length}턴).`)
  }
  for (const turn of request.history ?? []) {
    if (turn.role !== 'user' && turn.role !== 'assistant') {
      throw new SchemaError('대화 기록의 role이 올바르지 않습니다.')
    }
    if (typeof turn.content !== 'string') {
      throw new SchemaError('대화 기록의 content가 문자열이 아닙니다.')
    }
  }
  const total = request.paragraphs.reduce((sum, item) => sum + item.text.length, 0)
  if (total > MAX_TOTAL_CHARS) {
    throw new SchemaError(
      `문서가 너무 깁니다(${total.toLocaleString('ko-KR')}자). 현재는 ${MAX_TOTAL_CHARS.toLocaleString('ko-KR')}자까지 지원합니다.`,
    )
  }
}
