/**
 * 알려진 양식(template)의 계약. 브라우저와 Worker가 같은 파일을 쓴다.
 *
 * 목적은 하나다. **한 번 뜯어본 양식은 다시 뜯어보지 않는다.**
 * 처음 보는 문서는 AI가 "이 문단이 제목이고, 저 셀이 기간이다"를 판단해야 한다.
 * 그 판단은 문서마다 한 번이면 충분하다. 같은 양식이 또 올라오면 저장해 둔
 * 필드 지도를 꺼내 쓰고, AI에게는 "무엇을 어떤 값으로 바꿀지"만 묻는다.
 *
 * 저장하는 것과 저장하지 않는 것을 분명히 나눈다.
 *
 * - 저장한다: 구조 해시, 뼈대, 필드의 **위치와 이름**, 라벨 텍스트, 값의 해시.
 * - 저장하지 않는다: 원본 HWPX, 이미지, 본문 전체, 필드에 실제로 적힌 값.
 *
 * 라벨(anchor)만 글자 그대로 남긴다. "항목", "사업 기간" 같은 양식 자체의
 * 문구라서 문서마다 같고, 이게 있어야 "이 양식이 맞나"를 대조할 수 있다.
 * 값 필드는 `sampleHash`만 남긴다. 바뀌었는지 알기에는 충분하고, 내용은 남지 않는다.
 */

import { paragraphChecksum } from './schema'

/** 라벨. 양식에 인쇄된 문구라 문서가 달라도 같아야 한다. */
export interface TemplateAnchor {
  readonly paragraphId: string
  readonly path: string
  /** 글자 그대로 저장한다. 양식 문구이지 사용자 데이터가 아니다. */
  readonly text: string
}

/** 사람이 채워 넣는 자리. */
export interface TemplateField {
  /** 기계용 키. 예: `title`, `period`. */
  readonly key: string
  /** 사람이 읽을 이름. 예: `문서 제목`. */
  readonly label: string
  readonly paragraphId: string
  readonly path: string
  /** 분석 당시 값의 해시. 내용은 저장하지 않는다. */
  readonly sampleHash: string
}

export interface TemplateDefinition {
  readonly name: string
  readonly fields: readonly TemplateField[]
  readonly anchors: readonly TemplateAnchor[]
}

export interface StoredTemplate extends TemplateDefinition {
  readonly id: string
  readonly structureHash: string
  readonly version: number
  readonly skeleton: string
}

/** 라벨은 양식 문구다. 길면 값일 확률이 높으니 저장하지 않는다. */
export const MAX_ANCHOR_CHARS = 40
/** 한 양식에서 들고 갈 최대 개수. 프롬프트와 저장 크기를 함께 묶어 둔다. */
export const MAX_FIELDS = 120
export const MAX_ANCHORS = 120

/** 이 비율 이상 라벨이 살아 있어야 같은 양식으로 인정한다. */
export const ANCHOR_MATCH_RATIO = 0.8

export const TEMPLATE_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: '이 양식의 이름. 예: 출장 보고서, 사업 제안서.',
    },
    fields: {
      type: 'array',
      description: '사람이 값을 채워 넣는 자리. 문서마다 내용이 달라지는 문단.',
      items: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: '영문 소문자와 밑줄로 된 기계용 키. 예: title, period.',
          },
          label: { type: 'string', description: '사람이 읽을 이름. 한국어.' },
          paragraphId: { type: 'string', description: '입력에 있는 문단 id.' },
        },
        required: ['key', 'label', 'paragraphId'],
        additionalProperties: false,
      },
    },
    anchors: {
      type: 'array',
      description:
        '양식에 인쇄된 고정 문구. 표 머리글, 항목 이름처럼 문서가 달라져도 같은 문단.',
      items: {
        type: 'object',
        properties: {
          paragraphId: { type: 'string', description: '입력에 있는 문단 id.' },
        },
        required: ['paragraphId'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'fields', 'anchors'],
  additionalProperties: false,
} as const

export const TEMPLATE_SYSTEM_PROMPT = `너는 한글(HWPX) 문서가 어떤 양식인지 한 번만 뜯어보는 도구다.

문단 목록을 받는다. 각 줄은 \`[문단id] (위치) "텍스트"\` 형식이고, 텍스트는
JSON 문자열이라 따옴표 안의 공백까지 실제 글자다.

이 문서를 **양식**으로 보고 두 가지로 나눈다.

- fields: 사람이 채워 넣는 자리. 다음 사람이 같은 양식을 쓰면 내용이 달라질 문단.
  예) 제목, 기간, 담당자, 금액, 본문 설명.
- anchors: 양식에 인쇄되어 있는 고정 문구. 누가 쓰든 그대로인 문단.
  예) 표 머리글("항목", "내용"), 항목 이름("사업 기간:"), 장 제목 번호.

판단 기준:
- 그 문단을 지우면 양식이 아니게 되는가 → anchor.
- 다음 사람이 다른 내용을 적을 자리인가 → field.
- 둘 다 애매하면 field로 둔다. anchor를 잘못 고르면 같은 양식을 못 알아본다.
- anchor는 짧고 고정된 문구만 고른다. 한 문장 넘는 서술형은 anchor가 아니다.
- 사람 이름, 날짜, 금액, 기관명처럼 문서마다 달라지는 값은 절대 anchor가 아니다.

paragraphId는 입력에 있는 id만 쓴다. 새로 만들지 않는다.
한 문단을 fields와 anchors 양쪽에 넣지 않는다.`

export class TemplateError extends Error {
  override name = 'TemplateError'
}

interface AnalysisInput {
  readonly id: string
  readonly text: string
  readonly path: string
}

/**
 * AI가 돌려준 분석을 저장 가능한 정의로 바꾼다.
 *
 * 받은 값을 그대로 믿지 않는다. 문단 id는 실제로 보낸 목록 안에 있어야 하고,
 * 라벨은 길이 제한을 넘으면 버린다. 값 필드의 내용은 해시로만 남긴다.
 */
export function toTemplateDefinition(
  value: unknown,
  paragraphs: readonly AnalysisInput[],
): TemplateDefinition {
  if (typeof value !== 'object' || value === null) {
    throw new TemplateError('양식 분석 응답이 객체가 아닙니다.')
  }
  const record = value as Record<string, unknown>
  const name = typeof record['name'] === 'string' && record['name'].trim() ? record['name'].trim() : '이름 없는 양식'
  if (!Array.isArray(record['fields']) || !Array.isArray(record['anchors'])) {
    throw new TemplateError('양식 분석 응답에 fields/anchors 배열이 없습니다.')
  }

  const known = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]))
  const claimed = new Set<string>()

  const fields: TemplateField[] = []
  for (const raw of record['fields'] as unknown[]) {
    const item = raw as Record<string, unknown>
    const paragraphId = typeof item?.['paragraphId'] === 'string' ? item['paragraphId'] : ''
    const source = known.get(paragraphId)
    if (!source || claimed.has(paragraphId)) continue
    const key = typeof item['key'] === 'string' && item['key'] ? item['key'] : `f${fields.length}`
    claimed.add(paragraphId)
    fields.push({
      key,
      label: typeof item['label'] === 'string' && item['label'] ? item['label'] : key,
      paragraphId,
      path: source.path,
      // 값은 저장하지 않는다. 바뀌었는지만 알면 된다.
      sampleHash: paragraphChecksum(source.text),
    })
    if (fields.length >= MAX_FIELDS) break
  }

  const anchors: TemplateAnchor[] = []
  for (const raw of record['anchors'] as unknown[]) {
    const item = raw as Record<string, unknown>
    const paragraphId = typeof item?.['paragraphId'] === 'string' ? item['paragraphId'] : ''
    const source = known.get(paragraphId)
    if (!source || claimed.has(paragraphId)) continue
    // 긴 문단은 라벨이 아니라 값일 가능성이 높다. 글자 그대로 저장하므로 보수적으로 자른다.
    if (source.text.length > MAX_ANCHOR_CHARS) continue
    claimed.add(paragraphId)
    anchors.push({ paragraphId, path: source.path, text: source.text })
    if (anchors.length >= MAX_ANCHORS) break
  }

  if (fields.length === 0 && anchors.length === 0) {
    throw new TemplateError('양식에서 필드도 라벨도 찾지 못했습니다.')
  }
  return { name, fields, anchors }
}
