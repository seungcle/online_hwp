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

import type { DocumentModel, Paragraph, ParagraphPiece } from './document'
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
    /** 탭·강제 줄나눔 자리표의 개수나 순서가 원문과 다르다. */
    | 'anchor-mismatch'
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
    // 빈 문단이라도 글자를 넣을 자리(빈 run)가 있으면 채운다. 자리가 아예 없을
    // 때만 거절한다 — 그때는 문단 구조를 새로 만들어야 하는데 그건 범위 밖이다.
    if (
      target.paragraph.fragments.length === 0 &&
      !target.paragraph.emptySlot &&
      operation.newText.length > 0
    ) {
      issues.push({
        paragraphId: operation.paragraphId,
        kind: 'empty-paragraph',
        message: '이 칸에는 글자를 넣을 자리가 없습니다. 문단 구조는 만들지 않습니다.',
        actualText: '',
      })
    }
    // 탭·강제 줄나눔은 우리가 만들거나 없앨 수 없다. 원문에 있던 그대로여야
    // 제자리에 남는다. 개수나 순서가 달라지면 어디에 둘지 알 수 없다.
    //
    // 자리표가 **없는** 문단은 예전처럼 너그럽게 둔다. 모델이 넣은 줄바꿈은
    // 공백으로 바꾸면 그만이고, 그것 때문에 수정을 통째로 버릴 이유가 없다.
    const want = anchorChars(target.paragraph.text)
    const got = anchorChars(operation.newText)
    if (want.length > 0 && want !== got) {
      issues.push({
        paragraphId: operation.paragraphId,
        kind: 'anchor-mismatch',
        message:
          '이 문단에는 탭이나 줄나눔이 들어 있습니다. 그 자리를 원문 그대로 두어야 합니다.',
        actualText: target.paragraph.text,
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
    const slot = target.paragraph.emptySlot

    if (target.paragraph.fragments.length === 0 && slot) {
      // 비어 있던 요소를 텍스트를 담은 요소로 넓힌다. charPr 참조는 그대로 남는다.
      const body = escapeXmlText(normalize(operation.newText))
      list.push({
        start: slot.start,
        end: slot.end,
        bytes: encoder.encode(`${slot.before}${body}${slot.after}`),
      })
    }

    // 탭·강제 줄나눔은 자리를 차지하는 요소다. 건드리지 않고 **그 자리에 둔 채**
    // 사이사이의 글자만 갈아끼운다. 예전에는 텍스트 노드만 보고 새 글자를 첫
    // 조각에 몰아넣어, 목차 줄의 폭 29961짜리 탭이 그대로 남아 글자가 10cm씩
    // 벌어졌다(실측).
    for (const [chunk, pieces] of layoutChunks(target.paragraph, operation.newText)) {
      pieces.forEach((piece, position) => {
        // 구간의 첫 글자 조각에 몰아넣는다. 그래야 그 자리의 글꼴·서식이 남는다.
        list.push({
          start: piece.start,
          end: piece.end,
          bytes: encoder.encode(escapeXmlText(position === 0 ? chunk : '')),
        })
      })
    }

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

/** 문자열에서 자리표만 순서대로 뽑는다. 개수와 순서를 함께 본다. */
function anchorChars(text: string): string {
  return (text.match(/[\t\n]/g) ?? []).join('')
}

/**
 * 새 글자를 **자리표(탭·강제 줄나눔)를 기준으로 갈라** 각 구간의 글자 조각에
 * 배정한다. 자리표 자체는 바이트를 건드리지 않으므로 원본 그대로 남는다.
 *
 * 자리표가 없는 문단(대부분)은 예전과 똑같이 동작한다 — 새 글자를 통째로 첫
 * 조각에 넣고 나머지를 비운다. 이때는 줄바꿈·탭 문자를 공백으로 바꾼다.
 * HWPX에서 진짜 줄나눔은 요소를 새로 만들어야 하는데 그건 이 범위를 넘는다.
 *
 * 자리표가 있는 문단은 `validatePlan`이 개수와 순서가 맞는지 미리 확인한다.
 */
function layoutChunks(
  paragraph: Paragraph,
  newText: string,
): [string, Extract<ParagraphPiece, { kind: 'text' }>[]][] {
  const texts = paragraph.pieces.filter(
    (piece): piece is Extract<ParagraphPiece, { kind: 'text' }> => piece.kind === 'text',
  )
  const anchors = paragraph.pieces.filter((piece) => piece.kind === 'anchor')
  if (anchors.length === 0) {
    return [[normalize(newText), texts]]
  }

  // 자리표를 기준으로 구간을 나눈다. 구간 수 = 자리표 수 + 1.
  const chunks = splitOnAnchors(newText, anchors.map((anchor) => anchor.char))
  const spans: Extract<ParagraphPiece, { kind: 'text' }>[][] = [[]]
  for (const piece of paragraph.pieces) {
    if (piece.kind === 'anchor') spans.push([])
    else spans[spans.length - 1]!.push(piece)
  }
  return chunks.map((chunk, index) => [chunk, spans[index] ?? []])
}

/** 자리표 문자를 순서대로 잘라 구간 글자를 만든다. */
function splitOnAnchors(text: string, chars: readonly string[]): string[] {
  const out: string[] = []
  let rest = text
  for (const char of chars) {
    const at = rest.indexOf(char)
    if (at < 0) {
      // validatePlan 이 먼저 막으므로 여기 오지 않는다. 와도 안전하게 끝낸다.
      out.push(rest)
      rest = ''
      continue
    }
    out.push(rest.slice(0, at))
    rest = rest.slice(at + char.length)
  }
  out.push(rest)
  return out
}

/** 자리표가 없는 문단에서 문단 하나에 들어갈 수 없는 문자를 정리한다. */
function normalize(text: string): string {
  return text.replace(/\r\n?|\n|\t/g, ' ')
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
