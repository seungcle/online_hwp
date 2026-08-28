/**
 * 브라우저 → Worker 호출.
 *
 * HWPX 파일은 보내지 않는다. 문단 id와 텍스트, 그리고 그 문단이 본문인지
 * 표 안인지 정도의 최소 힌트만 보낸다.
 */

import type { Block, DocumentModel } from '../hwpx/document'
import { PatchError, type EditPlan, type PatchIssue } from '../hwpx/patch'
import {
  SchemaError,
  paragraphChecksum,
  parseEditPlanResponse,
  validateRequest,
  type ConversationTurn,
  type DocumentParagraph,
  type EditPlanResponse,
} from './schema'

export class AiError extends Error {
  override name = 'AiError'
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

/** AI에 보낼 문단 목록. 빈 문단은 바꿀 수 없으므로 제외한다. */
export function collectParagraphs(model: DocumentModel): DocumentParagraph[] {
  const out: DocumentParagraph[] = []
  for (const section of model.sections) {
    walk(section.blocks, '본문', out)
  }
  return out
}

function walk(blocks: readonly Block[], where: string, out: DocumentParagraph[]): void {
  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      if (block.text.trim().length > 0) {
        out.push({ id: block.id, text: block.text, where })
      }
      continue
    }
    if (block.kind === 'table') {
      block.rows.forEach((row, rowIndex) => {
        row.forEach((cell, columnIndex) => {
          walk(cell.blocks, `표 ${rowIndex + 1}행 ${columnIndex + 1}열`, out)
        })
      })
    }
  }
}

export async function requestEditPlan(
  instruction: string,
  paragraphs: readonly DocumentParagraph[],
  history: readonly ConversationTurn[] = [],
  signal?: AbortSignal,
): Promise<EditPlanResponse> {
  const payload = { instruction, paragraphs, ...(history.length ? { history } : {}) }
  try {
    validateRequest(payload)
  } catch (error) {
    throw new AiError(
      error instanceof SchemaError ? error.message : '요청을 만들지 못했습니다.',
      'bad_request',
    )
  }

  let response: Response
  try {
    response = await fetch('/api/edit-plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AiError('요청을 취소했습니다.', 'aborted')
    }
    throw new AiError('AI 서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.', 'network')
  }

  if (!response.ok) {
    const detail = await readError(response)
    throw new AiError(detail.message, detail.code)
  }

  try {
    // Worker가 이미 검증했지만 여기서 다시 본다. 응답을 그대로 믿지 않는다.
    return parseEditPlanResponse(await response.json())
  } catch (error) {
    throw new AiError(
      error instanceof SchemaError ? error.message : 'AI 응답을 이해하지 못했습니다.',
      'invalid_plan',
    )
  }
}

/**
 * AI 응답을 patch engine이 받을 수 있는 Edit Plan으로 바꾼다.
 *
 * 여기가 이 파일에서 제일 중요한 부분이다. `oldText`는 **AI가 준 값을 쓰지 않고**
 * 방금 AI에게 보낸 `paragraphs`에서 그대로 꺼낸다. 그래서 patch engine의
 * 바이트 단위 대조는 "우리가 보여 준 문단이 지금도 그대로인가"를 확인하게 된다.
 * 그게 원래 그 검증이 막으려던 것이다. 모델이 공백을 옮겨 적는 솜씨는 상관이 없다.
 *
 * 대신 "AI가 다른 문단을 보고 이 id를 적은 것은 아닌가"는 검증코드로 확인한다.
 * 프롬프트 줄에 실린 코드와 그 id의 실제 텍스트에서 계산한 코드가 한 글자라도
 * 다르면 계획 전체를 버린다. 부분 적용은 없다.
 */
export function resolveEditPlan(
  response: EditPlanResponse,
  paragraphs: readonly DocumentParagraph[],
): EditPlan {
  const sent = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph.text]))
  const issues: PatchIssue[] = []
  const seen = new Set<string>()
  const operations: EditPlan['operations'][number][] = []

  for (const operation of response.operations) {
    const text = sent.get(operation.paragraphId)
    if (text === undefined) {
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
        actualText: text,
      })
      continue
    }
    seen.add(operation.paragraphId)

    if (paragraphChecksum(text) !== operation.checksum) {
      issues.push({
        paragraphId: operation.paragraphId,
        kind: 'checksum-mismatch',
        message: 'AI가 짚은 문단과 실제로 보고 있던 내용이 어긋납니다.',
        actualText: text,
      })
      continue
    }

    const newText = keepOuterSpacing(text, operation.newText)
    // 모델은 고칠 것이 없는 문단도 계획에 넣곤 한다. 글자가 같다면 손대지 않는다.
    // 내용이 같아도 적용하면 문단의 텍스트 조각이 하나로 합쳐지는데, 형광펜처럼
    // 조각 사이에 끼어 있던 서식이 그때 사라진다. 안 바꾸는 것이 맞다.
    if (newText === text) continue

    operations.push({
      type: 'replace_text',
      paragraphId: operation.paragraphId,
      oldText: text,
      newText,
      ...(operation.reason ? { reason: operation.reason } : {}),
    })
  }

  if (issues.length > 0) {
    throw new PatchError(
      `수정 계획 ${issues.length}건이 어느 문단을 가리키는지 확인되지 않아 적용하지 않았습니다.`,
      issues,
    )
  }
  return { operations, summary: response.summary }
}

/**
 * 문단 앞뒤의 공백을 원문 그대로 되돌린다.
 *
 * 한글 문서는 들여쓰기를 문단 앞 공백으로 넣는 일이 흔하다(실측 27%).
 * 모델은 문장을 다듬으면서 이 공백을 군더더기로 보고 지운다. 프롬프트로
 * 부탁해도 지운다 — 실제로 gpt-4.1-mini는 들여쓰기 있는 문단 6개 전부에서
 * 앞 공백을 떨어뜨렸다. 그러면 검증은 통과하는데 문서 모양이 조용히 바뀐다.
 *
 * 그래서 부탁하지 않고 기계적으로 되돌린다. 모델이 맡는 것은 문장이고,
 * 들여쓰기는 레이아웃에 가깝다. 이 도구는 레이아웃을 건드리지 않는다.
 * (제로폭 공백은 `trim`의 대상이 아니므로 내용으로 취급되어 그대로 남는다.)
 */
function keepOuterSpacing(original: string, replacement: string): string {
  const body = replacement.trim()
  if (body.length === 0 || original.trim().length === 0) return replacement
  const lead = original.slice(0, original.length - original.trimStart().length)
  const trail = original.slice(original.trimEnd().length)
  return `${lead}${body}${trail}`
}

async function readError(response: Response): Promise<{ code: string; message: string }> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } }
    if (body.error?.message) {
      return { code: body.error.code ?? 'error', message: body.error.message }
    }
  } catch {
    // 본문이 JSON이 아니면 상태 코드로 안내한다.
  }
  if (response.status === 404) {
    return {
      code: 'not_deployed',
      message:
        'AI 기능이 이 환경에서 실행되고 있지 않습니다. (개발 중이라면 wrangler dev를 함께 띄워 주세요.)',
    }
  }
  return { code: 'error', message: `AI 요청이 실패했습니다 (HTTP ${response.status}).` }
}
