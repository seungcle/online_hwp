/**
 * Edit Plan을 실제 HWPX 바이트에 반영한다.
 *
 * 규칙 두 가지가 전부다.
 *
 * 1. **검증을 통과하지 못하면 아무것도 바꾸지 않는다.** 한 건이라도 어긋나면
 *    부분 적용 없이 통째로 실패한다. AI가 엉뚱한 문단을 짚었을 때 문서가
 *    조용히 망가지는 것보다 아무 일도 일어나지 않는 편이 낫다.
 * 2. **바뀌는 바이트 구간만 교체한다.** XML을 다시 직렬화하지 않는다.
 *    그래서 서식, 표, 이미지, 레이아웃이 원본 그대로 남는다.
 *
 * 치환 단위는 문단이다. `oldText`는 대상 문단의 **현재 전체 텍스트**여야 하고
 * `newText`가 그 자리를 통째로 대신한다. 부분 문자열을 다루지 않는 이유는
 * 같은 문구가 여러 번 나올 때 생기는 모호함을 아예 없애기 위해서다.
 *
 * `oldText`는 AI가 써 보낸 값이 아니다. 브라우저가 AI에게 보여 준 바로 그
 * 문자열을 그대로 들고 있다가 넣는다(`ai/client.ts`의 `resolveEditPlan`).
 * 그래서 아래 대조는 "계획을 세운 시점의 문서와 지금 문서가 같은가"를 묻는다.
 */

import type { DocumentModel, Paragraph } from './document'
import { escapeXmlText } from './xml'

export interface ReplaceTextOperation {
  readonly type: 'replace_text'
  /** 대상 문단 id. 예: `s0-p12`. */
  readonly paragraphId: string
  /**
   * 계획을 세운 시점의 문단 전체 텍스트. 지금 문서와 한 글자라도 다르면
   * 계획 전체를 버린다. AI가 아니라 브라우저가 채운다.
   */
  readonly oldText: string
  readonly newText: string
  /** AI가 남긴 변경 이유. 화면에 보여 주기만 한다. */
  readonly reason?: string
}

export type EditOperation = ReplaceTextOperation

export interface EditPlan {
  readonly operations: readonly EditOperation[]
  /** AI가 요약한 전체 변경 취지. */
  readonly summary?: string
}

export interface AppliedChange {
  readonly paragraphId: string
  readonly oldText: string
  readonly newText: string
  readonly reason?: string
  /** 이 문단이 표 셀 안에 있었는지 등, 사용자에게 위치를 알려 주기 위한 값. */
  readonly sectionIndex: number
}

export interface PatchIssue {
  readonly paragraphId: string
  readonly kind:
    | 'unknown-target'
    | 'text-mismatch'
    | 'empty-paragraph'
    | 'duplicate-target'
    /** AI가 짚은 id와 AI가 보고 있던 내용이 어긋난다. `resolveEditPlan`이 낸다. */
    | 'checksum-mismatch'
  readonly message: string
  /** 실제 문서의 현재 텍스트. 무엇이 어긋났는지 보여 주기 위해 함께 넘긴다. */
  readonly actualText?: string
}

export class PatchError extends Error {
  override name = 'PatchError'
  constructor(
    message: string,
    readonly issues: readonly PatchIssue[],
  ) {
    super(message)
  }
}

export interface PatchResult {
  /** section 파일 이름 → 수정된 XML 바이트. 바뀐 것만 들어 있다. */
  readonly sections: Map<string, Uint8Array>
  readonly changes: readonly AppliedChange[]
}

interface Located {
  readonly paragraph: Paragraph
  readonly sectionIndex: number
  readonly sectionName: string
}

function index(model: DocumentModel): Map<string, Located> {
  const map = new Map<string, Located>()
  for (const section of model.sections) {
    for (const paragraph of section.paragraphs) {
      map.set(paragraph.id, {
        paragraph,
        sectionIndex: section.index,
        sectionName: section.name,
      })
    }
  }
  return map
}

/**
 * 계획을 검증한다. 문제를 전부 모아서 돌려준다 — 첫 번째에서 멈추지 않는다.
 * 사용자가 무엇이 왜 안 됐는지 한 번에 볼 수 있어야 하기 때문이다.
 */
export function validatePlan(model: DocumentModel, plan: EditPlan): PatchIssue[] {
  const located = index(model)
  const issues: PatchIssue[] = []
  const seen = new Set<string>()

  for (const operation of plan.operations) {
    const target = located.get(operation.paragraphId)
    if (!target) {
      issues.push({
        paragraphId: operation.paragraphId,
        kind: 'unknown-target',
        message: `문서에 없는 문단입니다: ${operation.paragraphId}`,
      })
      continue
    }
    if (seen.has(operation.paragraphId)) {
      issues.push({
        paragraphId: operation.paragraphId,
        kind: 'duplicate-target',
        message: `같은 문단을 두 번 수정하려고 합니다: ${operation.paragraphId}`,
        actualText: target.paragraph.text,
      })
      continue
    }
    seen.add(operation.paragraphId)

    if (target.paragraph.text !== operation.oldText) {
      issues.push({
        paragraphId: operation.paragraphId,
        kind: 'text-mismatch',
        message: '원문이 현재 문서와 다릅니다. 문서가 바뀌었거나 대상을 잘못 짚었습니다.',
        actualText: target.paragraph.text,
      })
      continue
    }
    if (target.paragraph.fragments.length === 0 && operation.newText.length > 0) {
      issues.push({
        paragraphId: operation.paragraphId,
        kind: 'empty-paragraph',
        message: '빈 문단에는 글자를 넣을 수 없습니다. 이 프로토타입은 문단 구조를 만들지 않습니다.',
        actualText: '',
      })
    }
  }
  return issues
}

/**
 * 계획을 적용해 수정된 section XML을 만든다.
 * 검증에 실패하면 `PatchError`를 던지고 아무것도 바꾸지 않는다.
 */
export function applyPlan(
  model: DocumentModel,
  sectionBytes: ReadonlyMap<string, Uint8Array>,
  plan: EditPlan,
): PatchResult {
  const issues = validatePlan(model, plan)
  if (issues.length > 0) {
    throw new PatchError(
      `수정 계획 ${issues.length}건이 현재 문서와 맞지 않아 적용하지 않았습니다.`,
      issues,
    )
  }

  const located = index(model)
  const edits = new Map<string, { start: number; end: number; bytes: Uint8Array }[]>()
  const changes: AppliedChange[] = []
  const encoder = new TextEncoder()

  for (const operation of plan.operations) {
    const target = located.get(operation.paragraphId)!
    const list = edits.get(target.sectionName) ?? []
    const fragments = target.paragraph.fragments

    fragments.forEach((fragment, position) => {
      // 값은 첫 조각에 넣는다. 그래야 그 자리의 글꼴·서식이 그대로 적용된다.
      // 나머지 조각은 비운다.
      const replacement = position === 0 ? normalize(operation.newText) : ''
      list.push({
        start: fragment.start,
        end: fragment.end,
        bytes: encoder.encode(escapeXmlText(replacement)),
      })
    })

    edits.set(target.sectionName, list)
    changes.push({
      paragraphId: operation.paragraphId,
      oldText: operation.oldText,
      newText: operation.newText,
      ...(operation.reason === undefined ? {} : { reason: operation.reason }),
      sectionIndex: target.sectionIndex,
    })
  }

  const sections = new Map<string, Uint8Array>()
  for (const [name, list] of edits) {
    const original = sectionBytes.get(name)
    if (!original) throw new Error(`section 바이트가 없습니다: ${name}`)
    sections.set(name, spliceBytes(original, list))
  }

  return { sections, changes }
}

/**
 * 문단 하나에 들어갈 수 없는 문자를 정리한다.
 *
 * 줄바꿈은 공백으로 바꾼다. HWPX에서 진짜 줄바꿈은 문단을 새로 만들거나
 * 강제 줄나눔 요소를 넣어야 하는데, 둘 다 이번 범위(텍스트 편집)를 넘는다.
 * 실제 한글 문서를 조사했을 때도 강제 줄나눔 요소의 실물 사례를 확보하지
 * 못해, 추측으로 XML 요소를 만들어 넣지 않기로 했다.
 */
function normalize(text: string): string {
  return text.replace(/\r\n?|\n/g, ' ')
}

export function spliceBytes(
  data: Uint8Array,
  edits: readonly { start: number; end: number; bytes: Uint8Array }[],
): Uint8Array {
  const ordered = [...edits].sort((a, b) => a.start - b.start)
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]!.start < ordered[i - 1]!.end) {
      throw new Error('수정 구간이 서로 겹칩니다.')
    }
  }
  let size = data.byteLength
  for (const edit of ordered) size += edit.bytes.byteLength - (edit.end - edit.start)

  const out = new Uint8Array(size)
  let read = 0
  let write = 0
  for (const edit of ordered) {
    out.set(data.subarray(read, edit.start), write)
    write += edit.start - read
    out.set(edit.bytes, write)
    write += edit.bytes.byteLength
    read = edit.end
  }
  out.set(data.subarray(read), write)
  return out
}
